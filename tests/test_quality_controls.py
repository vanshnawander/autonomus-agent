from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from orchestrator.control_loop import Orchestrator
from orchestrator.pty_manager import PTYManager
from orchestrator.recorder import Recorder
from orchestrator.roles import build_pipeline
from orchestrator.safety import SafetyGate, classify_risk
from orchestrator.schemas import Risk
from orchestrator.searxng import _safe_output, append_ledger
from orchestrator.server_inventory import _validate_remote_command, load_inventory, redacted_inventory
from orchestrator.session_store import SessionStore


def _inventory(path: Path) -> None:
    path.write_text(json.dumps({
        "servers": [{
            "name": "gpu-a",
            "host": "10.0.0.7",
            "user": "research",
            "type": "gpu",
            "password": "never-print-this",
            "restrictions": {
                "workdir": "/srv/research/project",
                "max_runtime_minutes": 20,
                "allowed_command_prefixes": ["python train.py", "nvidia-smi"],
            },
        }],
    }))
    path.chmod(0o600)


def test_double_gate_pipeline_order() -> None:
    roles = {
        "literature-survey", "critic", "reviewer", "methodology",
        "experiment-executor", "paper-writer",
    }
    assert build_pipeline(roles) == [
        "literature-survey", "critic", "reviewer",
        "methodology", "critic", "reviewer",
        "experiment-executor", "critic", "reviewer",
        "paper-writer", "critic", "reviewer",
    ]


def test_persistent_agent_prompt_survives_restore_and_spawn(tmp_path: Path) -> None:
    recorder = Recorder(tmp_path / "logs")
    store = SessionStore(recorder=recorder)
    store.create(
        "persistent-prompt",
        "audit prompt propagation",
        [],
        [("survey", "literature-survey", None, str(tmp_path), "always inspect primary PDFs")],
    )
    restored = SessionStore(recorder=Recorder(tmp_path / "logs")).restore("persistent-prompt")
    assert restored.get_agent("survey").extra_prompt == "always inspect primary PDFs"

    orchestrator = Orchestrator(PTYManager(), SessionStore(), SafetyGate())
    with (
        patch.object(PTYManager, "build_command", return_value="true") as build,
        patch("orchestrator.control_loop.PTYSession.start"),
        patch.object(orchestrator, "_control_loop"),
    ):
        orchestrator.start_agent(restored, "survey")
        assert "always inspect primary PDFs" in build.call_args.args[0]
    orchestrator.shutdown()


def test_private_inventory_is_redacted_and_policy_bounded(tmp_path: Path) -> None:
    path = tmp_path / "servers.json"
    _inventory(path)
    server = load_inventory(path)["gpu-a"]
    rendered = json.dumps(redacted_inventory(path))
    assert "never-print-this" not in rendered
    assert '"auth": "password"' in rendered
    assert _validate_remote_command(server, ["python", "train.py", "--seed", "4"]) == "python train.py --seed 4"
    with pytest.raises(ValueError, match="safety policy"):
        _validate_remote_command(server, ["python", "train.py", "&&", "rm", "-rf", "/"])

    path.chmod(0o644)
    with pytest.raises(ValueError, match="0600"):
        load_inventory(path)


def test_searxng_ledger_marks_discovery_unreviewed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    output = _safe_output("outputs/literature/search_log.jsonl")
    count = append_ledger(output, "test query", {
        "results": [{"url": "https://example.test/paper", "title": "Paper", "content": "snippet"}],
    }, "http://127.0.0.1:8080")
    assert count == 1
    row = json.loads(output.read_text().strip())
    assert row["decision"] == "unreviewed"
    assert "primary source" in row["reason"]
    with pytest.raises(ValueError, match="inside"):
        _safe_output(str(tmp_path.parent / "escaped.jsonl"))


@pytest.mark.parametrize("command", [
    "ssh research@gpu-a python train.py",
    "sshpass -p secret ssh host",
    "scp model.pt host:/tmp/",
    "rsync model.pt research@host:/tmp/",
])
def test_direct_remote_access_is_high_risk(command: str) -> None:
    assert classify_risk(command) is Risk.high

def test_gate_handoffs_rewind_through_critic() -> None:
    store = SessionStore()
    session = store.create(
        "gate-flow",
        "verify two-gate state machine",
        [],
        [
            ("survey", "literature-survey", None, None),
            ("critic", "critic", None, None),
            ("reviewer", "reviewer", None, None),
        ],
    )
    orchestrator = Orchestrator(PTYManager(), store, SafetyGate())
    with patch.object(orchestrator, "start_agent") as start, patch.object(orchestrator, "restart_agent") as restart:
        orchestrator._handle_handoff(session, "survey", kind="done", stage="literature-survey")
        assert session.current_stage() == "critic"
        assert start.call_args.args[1] == "critic"

        orchestrator._handle_handoff(session, "critic", kind="approve", stage="literature-survey")
        assert session.current_stage() == "reviewer"
        assert start.call_args.args[1] == "reviewer"

        orchestrator._handle_handoff(
            session,
            "reviewer",
            kind="reject",
            stage="literature-survey",
            reason="evidence mismatch",
        )
        assert session.current_stage() == "literature-survey"
        assert restart.call_args.args[1] == "survey"
        assert restart.call_args.kwargs["resume"] is False

        orchestrator._handle_handoff(session, "survey", kind="done", stage="literature-survey")
        assert session.current_stage() == "critic"


@pytest.mark.parametrize("prefix", [
    "/usr/bin/python3", "python3.12", "python -c", "python -m",
    "/bin/bash -c", "env python train.py", "python -",
])
def test_inventory_rejects_interpreter_escape_prefixes(tmp_path, prefix):
    path = tmp_path / "servers.json"
    _inventory(path)
    data = json.loads(path.read_text())
    data["servers"][0]["restrictions"]["allowed_command_prefixes"] = [prefix]
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        load_inventory(path)


@pytest.mark.parametrize(("field", "value"), [
    ("enabled", "false"), ("port", True), ("password", 42),
    ("host", "-oProxyCommand=bad"), ("user", "name@otherhost"),
])
def test_inventory_rejects_invalid_connection_fields(tmp_path, field, value):
    path = tmp_path / "servers.json"
    _inventory(path)
    data = json.loads(path.read_text())
    data["servers"][0][field] = value
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        load_inventory(path)


def test_remote_deadline_runs_on_server_and_password_not_in_argv(tmp_path):
    from unittest.mock import MagicMock
    from orchestrator.server_inventory import run_remote
    path = tmp_path / "servers.json"
    _inventory(path)
    proc = MagicMock()
    proc.wait.return_value = 0
    with patch("orchestrator.server_inventory.shutil.which", return_value="/usr/bin/sshpass"), patch(
        "orchestrator.server_inventory.subprocess.Popen", return_value=proc
    ) as spawn, patch("orchestrator.server_inventory.os.write", return_value=17):
        assert run_remote(path, "gpu-a", ["python", "train.py"]) == 0
    argv = spawn.call_args.args[0]
    assert "never-print-this" not in " ".join(argv)
    assert "exec timeout --signal=TERM --kill-after=10s 1200s python train.py" in argv[-1]
    assert "StrictHostKeyChecking=yes" in argv
    proc.wait.assert_called_once_with(timeout=1245)

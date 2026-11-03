"""CLI adapter plugins: launch flags, dialogs, menus, session ids, markers."""
from __future__ import annotations

import json
import os
import shlex
import time
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from orchestrator.agents import LaunchContext, get_adapter, list_adapters
from orchestrator.agents.codex import CodexAdapter
from orchestrator.agents.opencode import OpenCodeAdapter
from orchestrator.control_loop import _APPROVE_RE, _DONE_RE, _QUESTION_RE, _REJECT_RE, Orchestrator
from orchestrator.pty_manager import PTYManager
from orchestrator.safety import SafetyGate
from orchestrator.schemas import ActionType, AgentState, AgentStatus, ControllerDecision, Risk
from orchestrator.session_store import SessionStore

# Screens captured from the real CLIs (Claude Code 2.1, Codex 0.164).
CLAUDE_TRUST_NO = """\
 Quick safety check: Is this a project you created or one you trust?
 Claude Code'll be able to read, edit, and execute files here.
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel"""
CLAUDE_TRUST_YES = CLAUDE_TRUST_NO.replace("❯ No, exit", "  No, exit").replace(
    "   Yes, I trust", " ❯ Yes, I trust"
)
CODEX_UPDATE = """\
› 1. Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'`)
  2. Skip
  3. Skip until next version
  enter continue · esc skip"""
CODEX_TRUST = """\
  Trust this folder? Codex can read, edit, and run files here.
› 1. Trust and continue
  2. Back to Agent Command Center
  enter continue · esc back"""
CLAUDE_MENU = """\
 Bash command
   pip install numpy
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for pip install commands in this project
   3. No, and tell Claude what to do differently (esc)"""
CODEX_MENU = """\
  Would you like to run the following command?
  $ pip install numpy
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (p)
  3. No, and tell Codex what to do differently (esc)"""


def test_registry_has_builtin_plugins_and_aliases():
    names = {adapter.name for adapter in list_adapters()}
    assert {"devin", "opencode", "codex", "claude-code"} <= names
    assert get_adapter("claude").name == "claude-code"
    assert get_adapter("OpenCode").name == "opencode"
    with pytest.raises(KeyError):
        get_adapter("nope")


@pytest.mark.parametrize("cli", ["devin", "opencode", "codex", "claude-code"])
def test_build_command_round_trips_awkward_prompts(cli):
    prompt = "Line one\n'quoted' \"double\" back\\slash $HOME `tick`"
    argv = shlex.split(PTYManager.build_command(prompt, cli=cli, cwd="/w"))
    assert argv[-1] == prompt


def test_claude_launch_assigns_and_resumes_session_ids():
    adapter = get_adapter("claude-code")
    fresh = adapter.build_argv(LaunchContext(prompt="p", new_session_id="abc", model="opus"))
    assert fresh[fresh.index("--session-id") + 1] == "abc"
    assert fresh[fresh.index("--model") + 1] == "opus"
    assert fresh[fresh.index("--permission-mode") + 1] == "acceptEdits"
    assert fresh[-2:] == ["--", "p"]
    resumed = adapter.build_argv(LaunchContext(prompt="p", resume_session_id="abc", new_session_id="zzz"))
    assert "--resume" in resumed and "--session-id" not in resumed
    with patch.dict(os.environ, {"DEVIN_ORCH_CLAUDE_CODE_EXTRA_ARGS": "--dangerously-skip-permissions --verbose"}):
        argv = adapter.build_argv(LaunchContext(prompt="p"))
    assert "--dangerously-skip-permissions" not in argv and "--verbose" in argv


def test_claude_env_drops_parent_session_markers():
    env = {"CLAUDECODE": "1", "CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDE_CODE_USE_BEDROCK": "1", "PATH": "/bin"}
    cleaned = get_adapter("claude-code").prepare_env(dict(env), LaunchContext(prompt=""))
    assert "CLAUDECODE" not in cleaned and "CLAUDE_CODE_CHILD_SESSION" not in cleaned
    assert cleaned["CLAUDE_CODE_USE_BEDROCK"] == "1"


def test_codex_launch_is_sandboxed_and_never_self_updates():
    adapter = get_adapter("codex")
    argv = adapter.build_argv(LaunchContext(prompt="p", cwd="/w"))
    assert argv[argv.index("--sandbox") + 1] == "workspace-write"
    assert argv[argv.index("--ask-for-approval") + 1] == "on-request"
    assert "check_for_update_on_startup=false" in argv
    assert argv[argv.index("--cd") + 1] == "/w"
    resumed = adapter.build_argv(LaunchContext(prompt="p", resume_session_id="u-1"))
    assert resumed[1:3] == ["resume", "u-1"]


def test_opencode_launch_and_permission_env():
    adapter = get_adapter("opencode")
    argv = adapter.build_argv(LaunchContext(prompt="p", resume_session_id="ses_1", model="a/b"))
    assert argv[argv.index("--session") + 1] == "ses_1"
    assert argv[argv.index("--prompt") + 1] == "p"
    env = adapter.prepare_env({}, LaunchContext(prompt=""))
    config = json.loads(env["OPENCODE_CONFIG_CONTENT"])
    assert config["permission"]["bash"]["*"] == "ask"
    # A user-supplied config wins.
    assert adapter.prepare_env({"OPENCODE_CONFIG_CONTENT": "{}"}, LaunchContext(prompt=""))[
        "OPENCODE_CONFIG_CONTENT"] == "{}"


def test_devin_build_command_keeps_legacy_flags():
    command = PTYManager.build_command("run", resume_session_id="hist", approval_mode="autonomous")
    assert "-r hist" in command and "--permission-mode smart" in command


def test_startup_dialogs_are_answered_only_for_trusted_workspaces():
    claude = get_adapter("claude-code")
    assert claude.startup_action(CLAUDE_TRUST_NO, trusted_workspace=True).keys == ("\x1b[B",)
    assert claude.startup_action(CLAUDE_TRUST_YES, trusted_workspace=True).keys == ("\r",)
    assert claude.startup_action(CLAUDE_TRUST_NO, trusted_workspace=False) is None
    codex = get_adapter("codex")
    # The update prompt is skipped even outside the workspace: its default runs an installer.
    assert codex.startup_action(CODEX_UPDATE, trusted_workspace=False).keys == ("\x1b",)
    assert codex.startup_action(CODEX_TRUST, trusted_workspace=True).keys == ("\r",)
    assert codex.startup_action(CODEX_TRUST, trusted_workspace=False) is None


def test_approval_menus_detect_one_time_option():
    claude = get_adapter("claude-code").menu_state(CLAUDE_MENU)
    assert claude.active and claude.approve_selected and "pip install" in claude.excerpt
    moved = get_adapter("claude-code").menu_state(
        CLAUDE_MENU.replace("❯ 1. Yes", "  1. Yes").replace("   2. Yes, and", " ❯ 2. Yes, and")
    )
    assert moved.active and not moved.approve_selected
    codex = get_adapter("codex").menu_state(CODEX_MENU)
    assert codex.active and codex.approve_selected
    assert not get_adapter("codex").menu_state("› Ask Codex to do anything").active
    devin = get_adapter("devin").menu_state("❭ 1 Yes  (Approve once)\nselect confirm")
    assert devin.active and devin.approve_selected


def test_controller_cannot_confirm_dont_ask_again_option():
    sessions = SessionStore()
    session = sessions.create(
        "menu-claude", "goal", [], [("worker", "experiment-executor", None, None, None, "claude-code")],
    )
    pty = PTYManager()
    fake = MagicMock()
    fake.is_alive.return_value = True
    pty.get = MagicMock(return_value=fake)
    orch = Orchestrator(pty, sessions, SafetyGate())
    decision = ControllerDecision(
        state=AgentState.waiting_for_input, action=ActionType.press_enter,
        confidence=0.9, risk=Risk.low, reason="approve",
    )
    fake.capture_visible_screen.return_value = CLAUDE_MENU
    orch._execute_decision(session, "worker", decision)
    fake.send_enter.assert_called_once_with()
    fake.reset_mock()
    fake.capture_visible_screen.return_value = CLAUDE_MENU.replace("❯ 1. Yes", "  1. Yes").replace(
        "   2. Yes, and", " ❯ 2. Yes, and"
    )
    orch._execute_decision(session, "worker", decision)
    fake.send_enter.assert_not_called()


@pytest.mark.parametrize("line", [
    "AGENT_DONE methodology",
    "● AGENT_DONE methodology",
    "⏺ AGENT_DONE methodology",
    "• AGENT_DONE methodology",
    "  ┃  AGENT_DONE methodology   ",
])
def test_done_marker_accepts_tui_decorations(line):
    match = _DONE_RE.search(line)
    assert match and match.group(1) == "methodology"


@pytest.mark.parametrize("line", [
    "❯ AGENT_DONE methodology",
    "> AGENT_DONE methodology",
    "print exactly `AGENT_DONE methodology`",
    "Then print AGENT_DONE methodology.",
])
def test_done_marker_rejects_echoed_or_inline_text(line):
    assert _DONE_RE.search(line) is None


def test_gate_and_question_markers_with_decorations():
    assert _APPROVE_RE.search("● APPROVE methodology").group(1) == "methodology"
    reject = _REJECT_RE.search("┃  REJECT methodology: missing seeds ┃")
    assert reject.group(1) == "methodology" and reject.group(2) == "missing seeds"
    assert _QUESTION_RE.search("• AGENT_QUESTION: which GPU?").group(1) == "which GPU?"


def test_codex_discovers_rollout_for_workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    started = time.time()
    day = tmp_path / "sessions" / time.strftime("%Y/%m/%d")
    day.mkdir(parents=True)
    for sid, cwd in (("other-id", "/elsewhere"), ("wanted-id", str(tmp_path / "ws"))):
        (day / f"rollout-x-{sid}.jsonl").write_text(
            json.dumps({"type": "session_meta", "payload": {"id": sid, "cwd": cwd}}) + "\n"
        )
    assert CodexAdapter().discover_session_id(str(tmp_path / "ws"), started) == "wanted-id"
    assert CodexAdapter().discover_session_id(str(tmp_path / "ws"), started + 3600) is None
    dest = CodexAdapter().export_trace("wanted-id", None, tmp_path / "out" / "t.json")
    assert dest and dest.read_text().startswith("{")


def test_opencode_discovers_newest_session_in_workspace(monkeypatch):
    started = time.time()
    rows = [
        {"id": "ses_old", "created": (started - 600) * 1000, "directory": "/ws"},
        {"id": "ses_other", "created": started * 1000 + 50, "directory": "/other"},
        {"id": "ses_new", "created": started * 1000 + 100, "directory": "/ws"},
    ]
    monkeypatch.setattr(OpenCodeAdapter, "_run_json", staticmethod(lambda *a, **k: rows))
    assert OpenCodeAdapter().discover_session_id("/ws", started) == "ses_new"


def test_status_change_is_not_a_new_attempt():
    sessions = SessionStore()
    session = sessions.create("attempts", "goal", [], [("a", "literature-survey", None, None)])
    session.mark_started("a")
    started = session.get_agent("a").started_at
    session.set_status("a", AgentStatus.paused)
    session.set_status("a", AgentStatus.running)
    mem = session.get_agent("a")
    assert mem.attempt_count == 1 and mem.started_at == started


def test_claude_agent_is_resumable_from_launch(monkeypatch):
    sessions = SessionStore()
    session = sessions.create(
        "claude-launch", "goal", [], [("lit", "literature-survey", None, None)], agent_cli="claude-code",
    )
    monkeypatch.setattr(type(get_adapter("claude-code")), "is_installed", lambda self: True)
    orch = Orchestrator(PTYManager(), sessions, SafetyGate())
    seen = {}

    def fake_build(prompt, **kwargs):
        seen.update(kwargs)
        return "true"

    with patch.object(PTYManager, "build_command", side_effect=fake_build):
        orch.start_agent(session, "lit")
    try:
        assert seen["cli"] == "claude-code" and seen["new_session_id"]
        assert session.get_agent("lit").devin_session_id == seen["new_session_id"]
        started = [e for e in session.events if e.type == "agent_started"][-1]
        assert started.data["cli"] == "claude-code"
    finally:
        orch.shutdown()


def test_missing_cli_fails_launch_clearly(monkeypatch):
    sessions = SessionStore()
    session = sessions.create("no-cli", "goal", [], [("lit", "literature-survey", None, None)], agent_cli="codex")
    monkeypatch.setattr(type(get_adapter("codex")), "is_installed", lambda self: False)
    with pytest.raises(RuntimeError, match="Codex CLI is not installed"):
        Orchestrator(PTYManager(), sessions, SafetyGate()).start_agent(session, "lit")


def test_ask_human_sets_attention_until_human_input():
    sessions = SessionStore()
    session = sessions.create("attention", "goal", [], [("w", "methodology", None, None)])
    pty = PTYManager()
    fake = MagicMock()
    fake.is_alive.return_value = True
    pty.get = MagicMock(return_value=fake)
    orch = Orchestrator(pty, sessions, SafetyGate())
    orch._execute_decision(session, "w", ControllerDecision(
        state=AgentState.needs_human, action=ActionType.ask_human, risk=Risk.unknown,
        reason="Which dataset split should be held out?",
    ))
    assert session.get_agent("w").attention == "Which dataset split should be held out?"
    assert any(e.type == "agent_attention" for e in session.events)
    orch.force_input(session, "w", ActionType.send_line, text="use split B")
    assert session.get_agent("w").attention is None


def test_menu_approval_question_shows_terminal_excerpt():
    gate = SafetyGate(allow_auto_approve=False)
    decision = ControllerDecision(
        state=AgentState.waiting_for_input, action=ActionType.press_enter, risk=Risk.medium, reason="r",
    )
    ok, item = gate.check("s", "a", decision, terminal_context=CODEX_MENU, screen_excerpt=CODEX_MENU)
    assert not ok and "pip install numpy" in item.question and "<press_enter>" in item.question


def test_api_lists_clis_and_rejects_unusable_ones(monkeypatch, tmp_path):
    from orchestrator import app as app_module
    from orchestrator.config import settings

    monkeypatch.setattr(settings, "workspace_root", tmp_path)
    client = TestClient(app_module.build_app())
    body = client.get("/agent-clis").json()
    assert {c["name"] for c in body["clis"]} >= {"devin", "opencode", "codex", "claude-code"}
    assert all("capabilities" in c for c in body["clis"])
    request = {
        "session_id": "cli-check", "goal": "g", "approval_mode": "manual",
        "agents": [{"agent_id": "lit", "role": "literature-survey"}],
    }
    unknown = client.post("/sessions", json={**request, "agent_cli": "nonexistent"})
    assert unknown.status_code == 400 and "unknown agent CLI" in unknown.json()["detail"]
    monkeypatch.setattr(type(get_adapter("opencode")), "is_installed", lambda self: False)
    missing = client.post("/sessions", json={**request, "agent_cli": "opencode"})
    assert missing.status_code == 400 and "not installed" in missing.json()["detail"]
    assert not (tmp_path / "cli-check").exists()


def test_agent_question_reported_once_and_does_not_hide_verdicts():
    sessions = SessionStore()
    session = sessions.create(
        "question", "goal", [],
        [("m", "methodology", None, None), ("c", "critic", None, None), ("r", "reviewer", None, None)],
    )
    session.stage_index = session.pipeline.index("critic")
    pty = PTYManager()
    fake = MagicMock()
    fake.recent_output.return_value = ""
    fake.capture_visible_screen.return_value = "● AGENT_QUESTION: which seed?"
    pty.get = MagicMock(return_value=fake)
    orch = Orchestrator(pty, sessions, SafetyGate())
    orch._check_markers(session, "c", fake, MagicMock())
    orch._check_markers(session, "c", fake, MagicMock())
    assert [e.type for e in session.events].count("agent_question") == 1
    assert session.get_agent("c").attention == "which seed?"
    fake.capture_visible_screen.return_value = "● AGENT_QUESTION: which seed?\n● APPROVE methodology"
    with patch.object(orch, "_handle_handoff") as handoff:
        orch._check_markers(session, "c", fake, MagicMock())
    handoff.assert_called_once()
    assert handoff.call_args.kwargs["kind"] == "approve"

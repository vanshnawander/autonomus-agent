import time
from pathlib import Path

from orchestrator.control_loop import Orchestrator
from orchestrator.pty_manager import PTYManager
from orchestrator.recorder import Recorder
from orchestrator.safety import SafetyGate
from orchestrator.schemas import AgentStatus, Event
from orchestrator.session_store import SessionStore


def _wait(predicate, timeout=3):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(.05)
    return False


def test_auxiliary_agent_is_visible_persisted_and_pipeline_independent(tmp_path):
    recorder = Recorder(log_dir=tmp_path / "logs")
    sessions = SessionStore(recorder=recorder)
    session = sessions.create(
        "project", "goal", [], [("main", "methodology", None, str(tmp_path))],
        workspace=str(tmp_path),
    )
    session.stage_index = 0
    session.active_agent = "main"
    before = (session.stage_index, session.active_agent, session.done)
    orch = Orchestrator(PTYManager(), sessions, SafetyGate(), recorder=recorder)
    runner = tmp_path / "runner.py"
    runner.write_text("import time\nprint('ready', flush=True)\ntime.sleep(30)\n")
    original = PTYManager.build_command
    PTYManager.build_command = staticmethod(
        lambda *args, **kwargs: f"python {runner}"
    )
    try:
        orch.launch_auxiliary_agent(
            session, "revision", "methodology", "audit methodology",
            cwd=str(tmp_path), model="swe-1.7",
        )
        assert _wait(lambda: orch.pty.get("revision", "project").is_alive())
        mem = session.get_agent("revision")
        assert mem.kind == "auxiliary"
        assert mem.model == "swe-1.7"
        assert mem.status == AgentStatus.running
        assert (session.stage_index, session.active_agent, session.done) == before
        manifest = (tmp_path / "logs/project/manifest.json").read_text()
        assert '"revision"' in manifest and '"kind": "auxiliary"' in manifest
        orch.pause_agent(session, "revision")
        assert mem.status == AgentStatus.paused
        orch.resume_agent_process(session, "revision")
        assert mem.status == AgentStatus.running
        orch.stop_agent(session, "revision")
        assert mem.status == AgentStatus.stopped
        assert (session.stage_index, session.active_agent, session.done) == before
    finally:
        PTYManager.build_command = original
        orch.shutdown()


def test_event_ids_are_unique_and_ordered():
    session = SessionStore().create(
        "events", "goal", [], [("main", "methodology", None, None)]
    )
    session.emit(Event(type="one", session_id="events", timestamp=10))
    session.emit(Event(type="two", session_id="events", timestamp=10))
    first, second = session.events
    assert first.event_id and second.event_id and first.event_id != second.event_id
    assert int(first.event_id.rsplit(":", 1)[1]) < int(second.event_id.rsplit(":", 1)[1])


def test_auxiliary_api_and_live_semantics(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from orchestrator.app import build_app
    from orchestrator.config import settings

    runner = tmp_path / "api_runner.py"
    runner.write_text("import time\nprint('ready', flush=True)\ntime.sleep(30)\n")
    monkeypatch.setattr(settings, "log_dir", tmp_path / "api-logs")
    monkeypatch.setattr(settings, "workspace_root", tmp_path)
    monkeypatch.setattr(
        PTYManager, "build_command",
        staticmethod(lambda *args, **kwargs: f"python {runner}"),
    )
    app = build_app()
    session = app.state.sessions.create(
        "api-aux", "goal", [], [("main", "methodology", None, str(tmp_path))],
        workspace=str(tmp_path),
    )
    session.done = True
    with TestClient(app) as client:
        before = client.get("/sessions/all").json()
        assert next(row for row in before if row["session_id"] == "api-aux")["live"] is False
        response = client.post("/sessions/api-aux/agents", json={
            "agent_id": "audit", "role": "reviewer", "prompt": "audit the result",
            "model": "swe-1.7",
        })
        assert response.status_code == 200, response.text
        assert response.json()["kind"] == "auxiliary"
        state = client.get("/sessions/api-aux").json()
        assert state["done"] is True
        assert state["active_agent"] is None
        assert state["active_agents"] == ["audit"]
        assert state["agents"]["audit"]["alive"] is True
        assert client.post("/sessions/api-aux/agents/audit/pause").status_code == 200
        assert client.post("/sessions/api-aux/agents/audit/resume-process").status_code == 200
        assert client.post("/sessions/api-aux/agents/audit/stop").status_code == 200
        after = client.get("/sessions/all").json()
        assert next(row for row in after if row["session_id"] == "api-aux")["live"] is False



def test_sse_cursor_replay_keeps_equal_timestamp_events_and_avoids_duplicates():
    from orchestrator.app import _events_after_cursor

    events = [
        Event(event_id="boot:1", type="one", session_id="s", timestamp=10),
        Event(event_id="boot:2", type="two", session_id="s", timestamp=10),
        Event(event_id="boot:3", type="three", session_id="s", timestamp=11),
    ]
    assert [event.event_id for event in _events_after_cursor(events, "boot:1")] == [
        "boot:2", "boot:3"
    ]
    assert _events_after_cursor(events, "boot:3") == []
    assert _events_after_cursor(events, "old-boot:99") == events

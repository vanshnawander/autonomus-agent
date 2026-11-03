from unittest.mock import Mock
from fastapi.testclient import TestClient
from orchestrator.app import build_app
from orchestrator.config import settings


def test_completed_pipeline_feedback_reaches_live_task(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'log_dir', tmp_path / 'logs')
    monkeypatch.setattr(settings, 'workspace_root', tmp_path)
    app = build_app()
    s = app.state.sessions.create('routing', 'goal', [], [('reviewer', 'reviewer', None, str(tmp_path))])
    s.done = True
    s.active_agent = 'reviewer'
    s.add_agent('implementation', 'experiment-executor')
    monkeypatch.setattr(app.state.pty, 'get', lambda aid, sid: Mock(is_alive=lambda: True) if aid == 'implementation' else None)
    inject = Mock()
    monkeypatch.setattr(app.state.orch, 'inject_feedback', inject)
    client = TestClient(app)
    r = client.post('/sessions/routing/feedback', json={'message': 'Continue the test'})
    assert r.status_code == 200
    assert r.json()['target_agent'] == 'implementation'
    assert inject.call_args.args[1] == 'implementation'
    s.add_agent('audit', 'critic')
    monkeypatch.setattr(app.state.pty, 'get', lambda aid, sid: Mock(is_alive=lambda: True) if aid != 'reviewer' else None)
    r = client.post('/sessions/routing/feedback', json={'message': 'Continue'})
    assert r.status_code == 409
    assert inject.call_count == 1

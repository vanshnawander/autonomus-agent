"""Regressions for terminal submission and controller recovery."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from orchestrator.control_loop import Orchestrator
from orchestrator.llm_controller import LLMController
from orchestrator.pty_manager import PTYSession
from orchestrator.schemas import ActionType, AgentStatus, FeedbackMode
from orchestrator.session_store import SessionStore


def make_orchestrator():
    session = SessionStore().create("reliability", "goal", [], [("worker", "methodology", None, None)])
    terminal = Mock()
    terminal.is_alive.return_value = True
    orch = Orchestrator.__new__(Orchestrator)
    orch.pty = Mock()
    orch.pty.get.return_value = terminal
    orch.recorder = None
    orch._idle = {}
    orch._input_versions = {}
    return orch, session, terminal


def test_send_line_submits_carriage_return():
    terminal = PTYSession("worker", "unused")
    terminal.child = Mock()
    terminal.send_line("continue")
    assert [call.args for call in terminal.child.send.call_args_list] == [("continue",), ("\r",)]
    terminal.child.sendline.assert_not_called()


def test_manual_input_resumes_paused_and_resets_streaks():
    orch, session, terminal = make_orchestrator()
    mem = session.get_agent("worker")
    session.set_status("worker", AgentStatus.paused)
    mem.idle_wait_streak = 15
    mem.low_confidence_streak = 3
    orch.force_input(session, "worker", ActionType.send_line, text="continue")
    terminal.resume.assert_called_once()
    terminal.send_line.assert_called_once_with("continue")
    assert mem.status == AgentStatus.running
    assert mem.idle_wait_streak == mem.low_confidence_streak == 0


def test_interrupt_feedback_to_dead_agent_is_queued():
    orch, session, terminal = make_orchestrator()
    terminal.is_alive.return_value = False
    orch.inject_feedback(session, "worker", "continue", FeedbackMode.interrupt)
    terminal.send_ctrl_c.assert_not_called()
    terminal.send_line.assert_not_called()
    assert session.get_agent("worker").pending_feedback == ["[interrupt] continue"]
    assert session.events[-1].type == "feedback_queued"
    assert session.events[-1].data["delivered"] is False


def test_interrupt_feedback_resumes_and_submits(monkeypatch):
    monkeypatch.setattr("orchestrator.control_loop.time.sleep", lambda _: None)
    orch, session, terminal = make_orchestrator()
    session.set_status("worker", AgentStatus.paused)
    orch.inject_feedback(session, "worker", "continue", FeedbackMode.interrupt)
    assert [call[0] for call in terminal.mock_calls][-3:] == ["resume", "send_ctrl_c", "send_line"]
    assert session.get_agent("worker").status == AgentStatus.running


def test_manual_input_does_not_bypass_pending_approval():
    orch, session, terminal = make_orchestrator()
    session.get_agent("worker").pending_approval_question = "Delete data?"
    with pytest.raises(RuntimeError, match="pending approval"):
        orch.force_input(session, "worker", ActionType.press_enter)
    terminal.send_enter.assert_not_called()


def make_controller(error):
    controller = LLMController.__new__(LLMController)
    controller._client = Mock()
    controller._model = "test"
    controller.last_error = None
    controller.consecutive_errors = 0
    controller._client.chat.completions.create.side_effect = error
    return controller


def test_transient_controller_failure_is_bounded_and_visible():
    controller = make_controller(TimeoutError("timed out"))
    decisions = [controller.decide({}, "", "") for _ in range(3)]
    assert [d.action for d in decisions] == [ActionType.wait, ActionType.wait, ActionType.ask_human]
    assert all(d.reason.startswith("controller error:") for d in decisions)
    assert controller.last_error == "TimeoutError: timed out"


def test_retired_model_suspends_immediately():
    error = RuntimeError("model unavailable")
    error.status_code = 404
    controller = make_controller(error)
    assert controller.decide({}, "", "").action == ActionType.ask_human


def test_success_clears_controller_error():
    controller = make_controller(TimeoutError("timed out"))
    controller.decide({}, "", "")
    controller._client.chat.completions.create.side_effect = None
    controller._client.chat.completions.create.return_value = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"state":"thinking","action":"wait","reason":"working"}'))])
    controller.decide({}, "", "")
    assert controller.last_error is None
    assert controller.consecutive_errors == 0


def test_inflight_controller_decision_is_discarded_after_manual_input():
    import threading
    from orchestrator.schemas import AgentState, ControllerDecision

    orch, session, terminal = make_orchestrator()
    stop = threading.Event()
    terminal.read_available.return_value = ""
    terminal.capture_visible_screen.return_value = "idle prompt"
    terminal.recent_output.return_value = ""
    idle = Mock()
    idle.is_idle.return_value = True
    orch._idle[(session.session_id, "worker")] = idle
    orch.controller = Mock()
    session.set_status("worker", AgentStatus.running)

    def decide(*args):
        orch.force_input(session, "worker", ActionType.send_line, text="new instruction")
        return ControllerDecision(state=AgentState.needs_human, action=ActionType.ask_human,
                                  reason="stale pause", confidence=1)

    orch.controller.decide.side_effect = decide
    original_emit = session.emit

    def emit(event):
        original_emit(event)
        if event.type == "controller_decision_discarded":
            stop.set()

    session.emit = emit
    orch._control_loop(session, "worker", stop)
    assert session.get_agent("worker").status == AgentStatus.running
    assert any(event.type == "controller_decision_discarded" for event in session.events)
    assert not any(event.type == "human_approval_needed" for event in session.events)
    terminal.send_line.assert_called_once_with("new instruction")

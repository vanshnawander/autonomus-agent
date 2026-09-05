"""Control loop + orchestrator.

This is the brain that ties everything together. For each running agent we run
a background thread that implements the spec's key loop:

    read terminal -> wait until quiet -> render screen
    -> ask LLM what to do -> execute ONE small action -> repeat

It also handles:
  - handoff detection (AGENT_DONE / APPROVE / REJECT / AGENT_QUESTION markers)
  - feedback injection (immediate / context / interrupt)
  - session restart / resume (stop agent, respawn with `devin -r <id>`)
  - approval gating via the safety layer
  - escalating to a human after too many low-confidence waits
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Optional

from .config import settings
from .idle_detector import IdleDetector
from .llm_controller import make_controller
from .pty_manager import PTYManager, PTYSession
from .recorder import Recorder
from .roles import get_role
from .safety import SafetyGate
from .schemas import (
    ActionType,
    AgentState,
    AgentStatus,
    ControllerDecision,
    Event,
    FeedbackMode,
    Risk,
)
from .session_store import Session, SessionStore

log = logging.getLogger(__name__)

# Markers agents print to signal the orchestrator.
_DONE_RE = re.compile(r"^\s*AGENT_DONE\s+([A-Za-z0-9_-]+)\s*$", re.IGNORECASE | re.MULTILINE)
_QUESTION_RE = re.compile(r"^\s*AGENT_QUESTION:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
_APPROVE_RE = re.compile(r"^\s*APPROVE\s+([A-Za-z0-9_-]+)\s*$", re.IGNORECASE | re.MULTILINE)
_REJECT_RE = re.compile(r"^\s*REJECT\s+([A-Za-z0-9_-]+):\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)


class Orchestrator:
    """Owns the PTY manager, session store, safety gate, and control threads."""

    def __init__(
        self,
        pty_manager: PTYManager,
        sessions: SessionStore,
        safety: SafetyGate,
        recorder: Optional[Recorder] = None,
    ) -> None:
        self.pty = pty_manager
        self.sessions = sessions
        self.safety = safety
        self.recorder = recorder
        self.controller = make_controller()
        self._loops: dict[tuple[str, str], threading.Thread] = {}
        self._stop_flags: dict[tuple[str, str], threading.Event] = {}
        self._idle: dict[tuple[str, str], IdleDetector] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _run_key(session_id: str, agent_id: str) -> tuple[str, str]:
        return (session_id, agent_id)

    @staticmethod
    def _reviewed_stage_for_gate(session: Session) -> Optional[str]:
        """Return the nearest preceding non-gate stage for the active gate."""
        if session.stage_index <= 0:
            return None
        for index in range(session.stage_index - 1, -1, -1):
            stage = session.pipeline[index]
            if not get_role(stage).is_gate:
                return stage
        return None

    def shutdown(self) -> None:
        """Stop all control loops and PTYs without triggering retry logic."""
        for stop_evt in list(self._stop_flags.values()):
            stop_evt.set()
        self.pty.stop_all()
        if self.recorder:
            self.recorder.close_all()

    # ------------------------------------------------------------------ recorder helpers

    def _arec(self, session_id: str, agent_id: str):
        """Get the per-agent recorder if configured."""
        if self.recorder is None:
            return None
        return self.recorder.get_agent(session_id, agent_id)

    def _trace_session_id(self, session_id: str, agent_id: str, attempt: int) -> Optional[str]:
        if self.recorder is None or attempt < 1:
            return None
        sdir = self.recorder.session_dir(session_id)
        path = sdir / "traces" / agent_id / f"{attempt:04d}.json" if sdir else None
        if path is None or not path.exists():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8")).get("session_id")
        except (OSError, json.JSONDecodeError, AttributeError):
            return None
        if isinstance(value, str) and value and all(c.isalnum() or c in "-_" for c in value):
            return value
        return None

    # ------------------------------------------------------------------ spawn

    def start_agent(
        self,
        session: Session,
        agent_id: str,
        resume_session_id: Optional[str] = None,
        extra_prompt: Optional[str] = None,
    ) -> None:
        """Spawn (or resume) an agent and start its control loop."""
        mem = session.get_agent(agent_id)
        if mem is None:
            raise KeyError(f"Agent {agent_id} not in session {session.session_id}")
        role = get_role(mem.role)
        runtime_parts = [
            f"Project goal:\n{session.goal}",
            "Project constraints:\n" + ("\n".join(f"- {item}" for item in session.constraints) or "- None declared"),
        ]
        if session.workspace:
            runtime_parts.append(f"Project workspace: {session.workspace}")
        if session.project_brief_path:
            runtime_parts.append(
                f"Read {session.project_brief_path} in full before acting; it is the immutable project brief."
            )
        if mem.extra_prompt:
            runtime_parts.append(f"Persistent instruction for this role:\n{mem.extra_prompt}")
        if extra_prompt:
            runtime_parts.append(f"Current-stage instruction:\n{extra_prompt}")
        repo_root = Path(__file__).resolve().parent.parent
        if role.key in {"literature-survey", "critic", "reviewer"}:
            search_helper = repo_root / "orchestrator" / "searxng.py"
            runtime_parts.append(
                f"Mandatory search command: {settings.python_executable} {search_helper} "
                f"'<query>' --url {settings.searxng_url} --output outputs/literature/search_log.jsonl. "
                "Use it for discovery; primary-source retrieval remains a separate verified step."
            )
        if role.key == "critic" and self.recorder is not None:
            audit_dir = self.recorder.session_dir(session.session_id)
            if audit_dir is not None:
                runtime_parts.append(
                    f"Read-only process-audit exception: inspect {audit_dir} to evaluate the prior stage's "
                    "terminal actions and controller decisions. Do not modify anything there."
                )
        if role.key == "experiment-executor" and settings.server_inventory_file.is_file():
            server_helper = repo_root / "orchestrator" / "server_inventory.py"
            runtime_parts.append(
                f"Private server inventory is configured at {settings.server_inventory_file}. "
                f"Inspect its redacted capabilities with `{settings.python_executable} {server_helper} "
                f"--file {settings.server_inventory_file} inspect`. Execute remote work only through "
                f"`{settings.python_executable} {server_helper} --file {settings.server_inventory_file} "
                "run <server> -- <command>`. Never read or print the inventory directly, and never invoke "
                "ssh, scp, sftp, rsync, or sshpass yourself. Treat its workdir, command allowlist, and "
                "runtime limit as hard boundaries."
            )
        composed_prompt = "\n\n".join(runtime_parts)

        # If a PTY already exists for this agent and is alive, don't double-spawn.
        existing = self.pty.get(agent_id, session.session_id)
        if existing and existing.is_alive():
            log.info("Agent %s already running, not respawning", agent_id)
            return

        # Use an explicit command override if the agent spec provided one;
        # otherwise build the default `devin` invocation from the role prompt.
        if mem.command:
            command = mem.command
        else:
            export_path = None
            if self.recorder is not None:
                sdir = self.recorder.session_dir(session.session_id)
                if sdir is not None:
                    export_path = str(
                        sdir / "traces" / agent_id / f"{mem.attempt_count + 1:04d}.json"
                    )
            command = PTYManager.build_command(
                role.full_prompt(composed_prompt),
                resume_session_id=resume_session_id,
                export_path=export_path,
                permission_mode=(
                    "accept-edits"
                    if session.approval_mode.value == "autonomous"
                    else "auto"
                ),
            )
        sess = self.pty.create(agent_id, command, cwd=mem.cwd, project_id=session.session_id)
        sess.start()
        if self.recorder is not None:
            self.recorder.register_agent(session.session_id, agent_id, role.key)
        session.set_status(agent_id, AgentStatus.running)
        session.active_agent = agent_id
        session.persist_runtime()
        arec = self._arec(session.session_id, agent_id)
        session.emit(Event(
            type="agent_started",
            session_id=session.session_id,
            agent_id=agent_id,
            data={
                "role": role.key,
                "resume": resume_session_id is not None,
                "attempt": mem.attempt_count,
                "recording_attempt": arec.attempt_id if arec else None,
                "devin_model": settings.devin_model,
            },
        ))

        # Start the project-scoped per-agent control loop.
        run_key = self._run_key(session.session_id, agent_id)
        stop_evt = threading.Event()
        self._stop_flags[run_key] = stop_evt
        self._idle[run_key] = IdleDetector(agent_id=agent_id)
        thread = threading.Thread(
            target=self._control_loop,
            args=(session, agent_id, stop_evt),
            name=f"loop-{agent_id}",
            daemon=True,
        )
        with self._lock:
            self._loops[run_key] = thread
        thread.start()

    # ------------------------------------------------------------------ stop / restart

    def stop_agent(self, session: Session, agent_id: str) -> None:
        stop_evt = self._stop_flags.get(self._run_key(session.session_id, agent_id))
        if stop_evt:
            stop_evt.set()
        self.pty.remove(agent_id, force=True, project_id=session.session_id)
        session.set_status(agent_id, AgentStatus.stopped)
        session.emit(Event(
            type="agent_stopped",
            session_id=session.session_id,
            agent_id=agent_id,
        ))
        self._finalize_agent_summary(session, agent_id, status="stopped")
        if self.recorder:
            self.recorder.close_agent(session.session_id, agent_id)

    def restart_agent(
        self,
        session: Session,
        agent_id: str,
        resume: bool = True,
        extra_prompt: Optional[str] = None,
    ) -> None:
        """Stop the agent and start a fresh one. If resume=True and we captured
        a Devin session id, resume that session instead of starting fresh."""
        mem = session.get_agent(agent_id)
        devin_id = mem.devin_session_id if mem else None
        self.stop_agent(session, agent_id)
        time.sleep(0.3)
        if not resume:
            # A fresh restart must not advertise stale Devin history through the
            # API or persist it into a later power-loss restore.
            session.set_devin_session_id(agent_id, None)
        resume_id = devin_id if (resume and devin_id) else None
        self.start_agent(session, agent_id, resume_session_id=resume_id, extra_prompt=extra_prompt)

    # ------------------------------------------------------------------ feedback

    def inject_feedback(
        self,
        session: Session,
        agent_id: str,
        message: str,
        mode: FeedbackMode,
    ) -> None:
        """Apply human feedback to an agent in one of three modes."""
        sess = self.pty.get(agent_id, session.session_id)
        arec = self._arec(session.session_id, agent_id)
        if mode == FeedbackMode.immediate:
            if sess and sess.is_alive():
                sess.send_line(message)
            else:
                # Queue it for when the agent is running.
                session.add_feedback(agent_id, message, mode)
            session.emit(Event(
                type="feedback_injected",
                session_id=session.session_id,
                agent_id=agent_id,
                data={"mode": mode.value, "message": message},
            ))
            if arec:
                arec.record_feedback(mode.value, message)
                arec.record_action("send_line", text=message, source="feedback")
        elif mode == FeedbackMode.interrupt:
            if sess and sess.is_alive():
                sess.send_ctrl_c()
                time.sleep(0.3)
                sess.send_line(message)
            session.emit(Event(
                type="feedback_interrupt",
                session_id=session.session_id,
                agent_id=agent_id,
                data={"message": message},
            ))
            if arec:
                arec.record_feedback(mode.value, message)
                arec.record_action("send_ctrl_c", source="feedback")
                arec.record_action("send_line", text=message, source="feedback")
        else:  # context
            session.add_feedback(agent_id, message, mode)
            session.emit(Event(
                type="feedback_queued",
                session_id=session.session_id,
                agent_id=agent_id,
                data={"message": message},
            ))
            if arec:
                arec.record_feedback(mode.value, message)

    # ------------------------------------------------------------------ force input

    def force_input(
        self,
        session: Session,
        agent_id: str,
        action: ActionType,
        text: Optional[str] = None,
        key: Optional[str] = None,
    ) -> None:
        """Bypass the LLM controller and send input directly (manual override)."""
        if action == ActionType.terminate:
            self.stop_agent(session, agent_id)
            return
        sess = self.pty.get(agent_id, session.session_id)
        if not sess or not sess.is_alive():
            raise RuntimeError(f"Agent {agent_id} is not running")
        self._apply_action(sess, action, text, key)
        session.emit(Event(
            type="manual_input",
            session_id=session.session_id,
            agent_id=agent_id,
            data={"action": action.value, "text": text, "key": key},
        ))
        arec = self._arec(session.session_id, agent_id)
        if arec:
            arec.record_action(action.value, text=text, key=key, source="manual")

    # ------------------------------------------------------------------ the loop

    def _control_loop(self, session: Session, agent_id: str, stop_evt: threading.Event) -> None:
        sess = self.pty.get(agent_id, session.session_id)
        idle = self._idle[self._run_key(session.session_id, agent_id)]
        mem = session.get_agent(agent_id)
        if sess is None or mem is None:
            return

        while not stop_evt.is_set():
            # 0. Per-agent hard timeout check.
            if settings.agent_timeout_s > 0 and mem.started_at is not None:
                elapsed = time.time() - mem.started_at
                if elapsed > settings.agent_timeout_s:
                    session.emit(Event(
                        type="agent_timeout",
                        session_id=session.session_id,
                        agent_id=agent_id,
                        data={"elapsed_s": elapsed, "timeout_s": settings.agent_timeout_s},
                    ))
                    self.stop_agent(session, agent_id)
                    return

            # 1. Drain whatever output is available.
            out = sess.read_available()
            visible_now = sess.capture_visible_screen()
            confirmation_menu_active = (
                "Approve once" in visible_now
                and "select" in visible_now
                and "confirm" in visible_now
            )
            if out:
                idle.update(sess)
                # Persist every raw byte the terminal emitted.
                arec = self._arec(session.session_id, agent_id)
                if arec:
                    arec.record_raw(out)
                # Harvest devin session id from the PTY.
                if not mem.devin_session_id:
                    trace_attempt = int(arec.attempt_id) if arec is not None else mem.attempt_count
                    trace_id = self._trace_session_id(session.session_id, agent_id, trace_attempt)
                    captured_id = trace_id or sess.devin_session_id
                    if captured_id:
                        session.set_devin_session_id(agent_id, captured_id)
                # Emit a terminal_output event (throttled by the loop cadence).
                session.emit(Event(
                    type="terminal_output",
                    session_id=session.session_id,
                    agent_id=agent_id,
                    data=out[-512:],  # keep events small
                ))
                # Check for handoff/done markers in the recent output.
                self._check_markers(session, agent_id, sess, idle)
                if mem.status in (AgentStatus.done, AgentStatus.stopped, AgentStatus.error):
                    return
                if not confirmation_menu_active:
                    continue

            # 2. If the process died, mark error and optionally retry.
            if not sess.is_alive():
                if mem.retry_count < settings.max_retries:
                    mem.retry_count += 1
                    session.emit(Event(
                        type="agent_retry",
                        session_id=session.session_id,
                        agent_id=agent_id,
                        data={"retry_count": mem.retry_count, "max": settings.max_retries},
                    ))
                    log.warning(
                        "Agent %s died; retrying (%d/%d)",
                        agent_id, mem.retry_count, settings.max_retries,
                    )
                    # Stop the dead PTY, then restart (resume if we have a session id).
                    self.pty.remove(agent_id, force=True, project_id=session.session_id)
                    time.sleep(0.5)
                    resume_id = mem.devin_session_id
                    self.start_agent(
                        session, agent_id,
                        resume_session_id=resume_id if resume_id else None,
                    )
                    return  # the new start_agent launches its own loop thread
                session.set_status(agent_id, AgentStatus.error)
                session.emit(Event(
                    type="agent_died",
                    session_id=session.session_id,
                    agent_id=agent_id,
                    data={"retries_exhausted": True},
                ))
                self._finalize_agent_summary(session, agent_id, status="error")
                return

            # 3. Sample screen stability even when no new bytes arrive. Quiet
            # prompts are stable precisely because read_available() returned empty.
            idle.update(sess)
            # Not idle yet? Short sleep and re-poll.
            if not confirmation_menu_active and not idle.is_idle(sess):
                time.sleep(settings.poll_interval_s)
                continue

            # 4. Idle -> ask the controller what to do.
            snapshot = session.snapshot_for_controller(agent_id)
            visible = sess.capture_visible_screen()
            recent = sess.recent_output(20)
            decision = self.controller.decide(snapshot, visible, recent)
            session.drain_feedback(agent_id)
            session.set_last_decision(agent_id, decision)
            session.emit(Event(
                type="llm_decision",
                session_id=session.session_id,
                agent_id=agent_id,
                data=decision.model_dump(),
            ))
            # Persist the screen snapshot + the decision + the controller I/O.
            arec = self._arec(session.session_id, agent_id)
            if arec:
                try:
                    arec.record_screen(visible, sess.cursor_position())
                    arec.record_decision(
                        decision.model_dump(),
                        raw_request={
                            **snapshot,
                            "visible_terminal": visible,
                            "recent_output": recent,
                        },
                    )
                except Exception:
                    log.exception("Failed to record controller turn for %s", agent_id)

            # 5. Low-confidence escalation.
            if decision.confidence < 0.4 and decision.action == ActionType.wait:
                mem.low_confidence_streak += 1
                if mem.low_confidence_streak >= settings.max_low_confidence_waits:
                    decision = ControllerDecision(
                        state=AgentState.needs_human,
                        action=ActionType.ask_human,
                        confidence=0.0,
                        risk=Risk.unknown,
                        reason="Too many low-confidence waits; escalating to human.",
                    )
            else:
                mem.low_confidence_streak = 0

            # 5b. Stuck-session detection: too many idle->wait decisions without
            # any text input. This catches agents that are alive but spinning.
            if decision.action == ActionType.wait:
                mem.idle_wait_streak += 1
                if (settings.max_idle_waits_without_input > 0
                        and mem.idle_wait_streak >= settings.max_idle_waits_without_input):
                    decision = ControllerDecision(
                        state=AgentState.needs_human,
                        action=ActionType.ask_human,
                        confidence=0.0,
                        risk=Risk.unknown,
                        reason=(
                            f"Stuck: {mem.idle_wait_streak} consecutive idle waits "
                            f"without input. Escalating to human."
                        ),
                    )
            else:
                mem.idle_wait_streak = 0

            # 6. Safety-gate any keystroke that could answer/approve a terminal
            # prompt. Risk is derived from both the key and visible context.
            approval_actions = {
                ActionType.send_text, ActionType.send_line, ActionType.press_enter,
                ActionType.press_key,
            }
            if decision.action in approval_actions:
                ok, approval = self.safety.check(
                    session.session_id,
                    agent_id,
                    decision,
                    terminal_context=f"{visible}\n{recent}",
                    allow_auto_approve=session.approval_mode.value == "autonomous",
                )
                if not ok and approval:
                    mem.pending_approval_question = approval.question
                    session.set_status(agent_id, AgentStatus.paused)
                    session.emit(Event(
                        type="human_approval_needed",
                        session_id=session.session_id,
                        agent_id=agent_id,
                        data={"approval_id": approval.id, "question": approval.question},
                    ))
                    # Wait until the human resolves it (or we're told to stop).
                    approved = self._wait_for_approval(
                        session, agent_id, approval.id, stop_evt
                    )
                    mem.pending_approval_question = None
                    if stop_evt.is_set():
                        return
                    session.set_status(agent_id, AgentStatus.running)
                    if approved:
                        # Execute exactly the decision the human inspected.
                        self._execute_decision(session, agent_id, decision)
                        if arec:
                            arec.record_action(
                                decision.action.value,
                                text=decision.text,
                                key=decision.key,
                                source="human_approval",
                            )
                    else:
                        # Dismiss an interactive confirmation without approving
                        # any operation shown in the terminal.
                        if sess.is_alive():
                            sess.send_escape()
                        if arec:
                            arec.record_action("send_escape", source="human_denial")
                        session.emit(Event(
                            type="human_approval_denied_handled",
                            session_id=session.session_id,
                            agent_id=agent_id,
                            data={"approval_id": approval.id},
                        ))
                    idle.reset()
                    continue

            # 7. Execute the one action.
            self._execute_decision(session, agent_id, decision)
            # Persist the executed action.
            arec = self._arec(session.session_id, agent_id)
            if arec:
                try:
                    arec.record_action(
                        decision.action.value,
                        text=decision.text,
                        key=decision.key,
                        source="controller",
                    )
                except Exception:
                    pass
            # Reset idle detector so we don't immediately re-trigger.
            idle.reset()
            time.sleep(settings.poll_interval_s)

    def _finalize_agent_summary(self, session: Session, agent_id: str, status: str) -> None:
        """Write the agent's summary.json with its final state + stats."""
        if self.recorder is None:
            return
        arec = self.recorder.get_agent(session.session_id, agent_id)
        if arec is None:
            return
        mem = session.get_agent(agent_id)
        if mem is None:
            return
        psess = self.pty.get(agent_id, session.session_id)
        try:
            arec.write_summary({
                "agent_id": agent_id,
                "role": mem.role,
                "status": status,
                "devin_session_id": mem.devin_session_id,
                "started_at": mem.started_at,
                "finished_at": mem.finished_at,
                "summary": mem.summary,
                "last_decision": mem.last_decision.model_dump() if mem.last_decision else None,
                "raw_log_path": str(arec.raw_path),
                "raw_log_bytes": arec.raw_path.stat().st_size if arec.raw_path.exists() else 0,
                "screen_snapshots": arec.screen_path.stat().st_size if arec.screen_path.exists() else 0,
                "audit_entries": arec.audit_path.stat().st_size if arec.audit_path.exists() else 0,
                "command": mem.command,
                "cwd": mem.cwd,
                "cols": psess.cols if psess else None,
                "rows": psess.rows if psess else None,
            })
        except Exception:
            pass

    # ------------------------------------------------------------------ markers

    def _check_markers(
        self,
        session: Session,
        agent_id: str,
        sess: PTYSession,
        idle: IdleDetector,
    ) -> None:
        mem = session.get_agent(agent_id)
        if mem is None:
            return
        # Don't re-process markers once the agent has reached a terminal state.
        if mem.status in (AgentStatus.done, AgentStatus.stopped, AgentStatus.error):
            return
        recent = sess.recent_output(30)

        # AGENT_DONE is valid only for the active work role and current stage.
        m = _DONE_RE.search(recent)
        if m:
            stage = m.group(1).lower()
            if get_role(mem.role).is_gate or stage != mem.role or session.current_stage() != mem.role:
                session.emit(Event(
                    type="invalid_stage_marker",
                    session_id=session.session_id,
                    agent_id=agent_id,
                    data={"marker": "AGENT_DONE", "stage": stage, "expected": session.current_stage()},
                ))
                return
            self.pty.remove(agent_id, force=True, project_id=session.session_id)
            self._handle_handoff(session, agent_id, kind="done", stage=stage)
            session.set_summary(agent_id, f"Stage {stage} reported done.")
            session.set_status(agent_id, AgentStatus.done)
            session.emit(Event(
                type="agent_done",
                session_id=session.session_id,
                agent_id=agent_id,
                data={"stage": stage},
            ))
            self._finalize_agent_summary(session, agent_id, status="done")
            if self.recorder:
                self.recorder.close_agent(session.session_id, agent_id)
            return

        # AGENT_QUESTION
        m = _QUESTION_RE.search(recent)
        if m:
            question = m.group(1).strip()
            session.emit(Event(
                type="agent_question",
                session_id=session.session_id,
                agent_id=agent_id,
                data={"question": question},
            ))
            return

        # Every gate verdict names the nearest preceding work stage.
        is_active_gate = get_role(mem.role).is_gate and session.current_stage() == mem.role
        expected_review_stage = self._reviewed_stage_for_gate(session) if is_active_gate else None
        m = _APPROVE_RE.search(recent)
        if m:
            stage = m.group(1).lower()
            if stage != expected_review_stage:
                session.emit(Event(
                    type="invalid_stage_marker",
                    session_id=session.session_id,
                    agent_id=agent_id,
                    data={"marker": "APPROVE", "stage": stage, "expected": expected_review_stage},
                ))
                return
            self.pty.remove(agent_id, force=True, project_id=session.session_id)
            self._handle_handoff(session, agent_id, kind="approve", stage=stage)
            session.set_status(agent_id, AgentStatus.done)
            session.emit(Event(
                type=f"{mem.role}_approved",
                session_id=session.session_id,
                agent_id=agent_id,
                data={"stage": stage},
            ))
            self._finalize_agent_summary(session, agent_id, status="done")
            if self.recorder:
                self.recorder.close_agent(session.session_id, agent_id)
            return

        m = _REJECT_RE.search(recent)
        if m:
            stage = m.group(1).lower()
            reason = m.group(2).strip()
            if stage != expected_review_stage:
                session.emit(Event(
                    type="invalid_stage_marker",
                    session_id=session.session_id,
                    agent_id=agent_id,
                    data={"marker": "REJECT", "stage": stage, "expected": expected_review_stage},
                ))
                return
            self.pty.remove(agent_id, force=True, project_id=session.session_id)
            self._handle_handoff(session, agent_id, kind="reject", stage=stage, reason=reason)
            session.set_status(agent_id, AgentStatus.done)
            session.emit(Event(
                type=f"{mem.role}_rejected",
                session_id=session.session_id,
                agent_id=agent_id,
                data={"stage": stage, "reason": reason},
            ))
            self._finalize_agent_summary(session, agent_id, status="done")
            if self.recorder:
                self.recorder.close_agent(session.session_id, agent_id)
            return

    def _handle_handoff(
        self,
        session: Session,
        from_agent: str,
        kind: str,
        stage: str,
        reason: str = "",
    ) -> None:
        """Advance the pipeline or send a stage back after a gate verdict."""
        mem = session.get_agent(from_agent)
        if mem is None:
            return
        role = get_role(mem.role)

        if kind == "reject":
            target = self._find_agent_for_role(session, stage)
            prior_indices = [
                index for index, candidate in enumerate(session.pipeline[: session.stage_index])
                if candidate == stage and not get_role(candidate).is_gate
            ]
            if not target or not prior_indices:
                session.emit(Event(
                    type="handoff_blocked",
                    session_id=session.session_id,
                    agent_id=from_agent,
                    data={"target": target, "reason": "reviewed work stage not found"},
                ))
                return
            target_mem = session.get_agent(target)
            if target_mem is None or target_mem.role not in role.can_handoff_to:
                session.emit(Event(
                    type="handoff_blocked",
                    session_id=session.session_id,
                    agent_id=from_agent,
                    data={"target": target, "reason": "role boundary"},
                ))
                return
            with session._lock:
                session.stage_index = prior_indices[-1]
                session.done = False
                session.active_agent = target
            session.record_handoff(from_agent, target, f"reject: {reason}")
            self.restart_agent(
                session, target, resume=False,
                extra_prompt=f"{mem.role.title()} rejected your {stage}: {reason}. Revise every blocking issue and preserve evidence of the changes.",
            )
            return

        # done / approve -> advance to next pipeline stage.
        next_stage = session.advance_stage()
        if next_stage is None:
            session.done = True
            session.emit(Event(
                type="pipeline_done",
                session_id=session.session_id,
                data={"goal": session.goal},
            ))
            return
        target = self._find_agent_for_role(session, next_stage)
        if target:
            target_mem = session.get_agent(target)
            if target_mem is None or target_mem.role not in role.can_handoff_to:
                session.emit(Event(
                    type="handoff_blocked",
                    session_id=session.session_id,
                    agent_id=from_agent,
                    data={"target": target, "reason": "role boundary"},
                ))
                return
            session.record_handoff(from_agent, target, kind)
            extra_prompt = None
            if get_role(next_stage).is_gate:
                gate_instruction = (
                    "Challenge the reasoning and idea worth before acceptance review."
                    if next_stage == "critic"
                    else "Perform an independent acceptance audit after reading the critic report."
                )
                extra_prompt = (
                    f"Evaluate the just-completed `{stage}` stage for project goal: {session.goal}. "
                    f"{gate_instruction} Apply every strict criterion and verify external claims."
                )
            elif kind == "approve":
                extra_prompt = f"The {mem.role} approved `{stage}`. Begin `{next_stage}` using only approved artifacts."
            self.start_agent(session, target, extra_prompt=extra_prompt)

    def _find_agent_for_role(self, session: Session, role_key: str) -> Optional[str]:
        for aid, mem in session.agents.items():
            if mem.role == role_key:
                return aid
        return None

    # ------------------------------------------------------------------ execution

    def _execute_decision(self, session: Session, agent_id: str, decision: ControllerDecision) -> None:
        sess = self.pty.get(agent_id, session.session_id)
        if decision.action == ActionType.wait:
            time.sleep((decision.duration_ms or 1000) / 1000.0)
            return
        if decision.action == ActionType.mark_done:
            # Completion is a state transition, not a terminal keystroke. Only
            # validated output markers in _check_markers may advance the stage.
            session.emit(Event(
                type="controller_mark_done_rejected",
                session_id=session.session_id,
                agent_id=agent_id,
                data={"reason": "completion requires a validated stage marker"},
            ))
            if sess and sess.is_alive():
                mem = session.get_agent(agent_id)
                stage = mem.role if mem else "stage"
                sess.send_line(
                    f"Completion was not accepted. Verify all artifacts, then print "
                    f"exactly AGENT_DONE {stage}."
                )
            return
        if decision.action == ActionType.terminate:
            self.stop_agent(session, agent_id)
            return
        if decision.action == ActionType.ask_human:
            session.set_status(agent_id, AgentStatus.paused)
            session.emit(Event(
                type="human_approval_needed",
                session_id=session.session_id,
                agent_id=agent_id,
                data={"question": decision.reason, "risk": decision.risk.value},
            ))
            return
        if decision.action == ActionType.ask_other_agent:
            target = decision.target_agent
            if target:
                session.emit(Event(
                    type="agent_to_agent",
                    session_id=session.session_id,
                    agent_id=agent_id,
                    data={"target": target, "message": decision.text},
                ))
                # Mediate: send the question to the other agent's terminal.
                target_sess = self.pty.get(target, session.session_id)
                if target_sess and target_sess.is_alive():
                    target_sess.send_line(decision.text or "")
                else:
                    # Queue as feedback for when that agent runs.
                    session.add_feedback(target, decision.text or "", FeedbackMode.context)
            return
        if decision.action == ActionType.transfer_to_agent:
            # Pipeline transitions are state changes and must come only from a
            # stage-matched marker handled by _check_markers. Letting the LLM
            # controller transfer directly can replay a stale marker visible in
            # a resumed terminal and bypass the reviewer gate.
            session.emit(Event(
                type="controller_transfer_rejected",
                session_id=session.session_id,
                agent_id=agent_id,
                data={
                    "target": decision.target_agent,
                    "reason": "handoff requires a validated stage marker",
                },
            ))
            if sess and sess.is_alive():
                mem = session.get_agent(agent_id)
                if mem and get_role(mem.role).is_gate:
                    reviewed_stage = self._reviewed_stage_for_gate(session)
                    if reviewed_stage is None:
                        return
                    sess.send_line(
                        "Do not transfer directly. Finish the current gate and print exactly "
                        f"APPROVE {reviewed_stage} or REJECT {reviewed_stage}: <actionable reasons>."
                    )
            return
        # Terminal keystroke actions.
        if sess and sess.is_alive():
            screen = sess.capture_visible_screen()
            menu_active = (
                "Approve once" in screen
                and "select" in screen
                and "confirm" in screen
            )
            confirms_menu = (
                decision.action == ActionType.press_enter
                or (
                    decision.action == ActionType.press_key
                    and (decision.key or "").lower() in {"1", "enter", "return"}
                )
            )
            approve_once_selected = re.search(
                r"(?m)^\s*❭\s*1\s+Yes\s+\(Approve once\)", screen
            ) is not None
            if menu_active and confirms_menu:
                if approve_once_selected:
                    sess.send_enter()
                return
            self._apply_action(sess, decision.action, decision.text, decision.key)

    @staticmethod
    def _apply_action(
        sess: PTYSession,
        action: ActionType,
        text: Optional[str] = None,
        key: Optional[str] = None,
    ) -> None:
        if action == ActionType.send_text:
            sess.send_text(text or "")
        elif action == ActionType.send_line:
            sess.send_line(text or "")
        elif action == ActionType.press_enter:
            sess.send_enter()
        elif action == ActionType.press_key:
            sess.press_key(key or "enter")
        elif action == ActionType.send_ctrl_c:
            sess.send_ctrl_c()
        elif action == ActionType.send_escape:
            sess.send_escape()

    # ------------------------------------------------------------------ approval wait

    def _wait_for_approval(
        self,
        session: Session,
        agent_id: str,
        approval_id: str,
        stop_evt: threading.Event,
    ) -> Optional[bool]:
        """Block until resolved and return True for approval, False for denial."""
        while not stop_evt.is_set():
            verdict = self.safety.consume_resolution(approval_id)
            if verdict is not None:
                return verdict
            items = self.safety.pending(session_id=session.session_id)
            if not any(i.id == approval_id for i in items):
                # Missing without an explicit verdict is treated as denial.
                return False
            time.sleep(0.5)
        return None

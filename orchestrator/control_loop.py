"""Control loop + orchestrator.

This is the brain that ties everything together. For each running agent we run
a background thread that implements the spec's key loop:

    read terminal -> wait until quiet -> render screen
    -> ask LLM what to do -> execute ONE small action -> repeat

It also handles:
  - handoff detection (AGENT_DONE / APPROVE / REJECT / AGENT_QUESTION markers)
  - feedback injection (immediate / context / interrupt)
  - session restart / resume (stop agent, respawn resuming its CLI session)
  - CLI specifics (launch flags, first-run dialogs, approval menus, session
    ids) via the adapter plugins in orchestrator/agents/
  - approval gating via the safety layer
  - escalating to a human after too many low-confidence waits
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Optional

from .agents import LaunchContext, get_adapter
from .agents.devin import DevinAdapter
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
from .terminal_screen import sanitize_ansi

log = logging.getLogger(__name__)

# Markers agents print to signal the orchestrator. TUIs decorate transcript
# lines (Claude Code `●`/`⏺`, Codex `•`, OpenCode `┃` borders), so a marker may
# follow such a prefix. Prompt-echo prefixes (`>`, `❯`, `›`) are deliberately
# not accepted so a quoted instruction can never advance the pipeline.
_DECOR = r"^[ \t●⏺•·┃│▌▎]*"
_TRAIL = r"[ \t┃│]*$"
_DONE_RE = re.compile(_DECOR + r"AGENT_DONE\s+([A-Za-z0-9_-]+)" + _TRAIL, re.IGNORECASE | re.MULTILINE)
_QUESTION_RE = re.compile(_DECOR + r"AGENT_QUESTION:\s*(.+?)" + _TRAIL, re.IGNORECASE | re.MULTILINE)
_APPROVE_RE = re.compile(_DECOR + r"APPROVE\s+([A-Za-z0-9_-]+)" + _TRAIL, re.IGNORECASE | re.MULTILINE)
_REJECT_RE = re.compile(_DECOR + r"REJECT\s+([A-Za-z0-9_-]+):\s*(.+?)" + _TRAIL, re.IGNORECASE | re.MULTILINE)

# Minimum seconds between session-id discovery scans (subprocess/filesystem).
_DISCOVERY_INTERVAL_S = 10.0


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
        self._input_versions: dict[tuple[str, str], int] = {}
        self._last_question: dict[tuple[str, str], str] = {}
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
        return DevinAdapter.session_id_from_trace(path)

    @staticmethod
    def _trusted_workspace(cwd: Optional[str]) -> bool:
        """Only orchestrator-created workspaces may be trusted automatically."""
        if not cwd:
            return False
        try:
            Path(cwd).resolve().relative_to(settings.workspace_root.resolve())
        except ValueError:
            return False
        return True

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
        adapter = get_adapter(session.cli_for(agent_id))
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
        # otherwise ask the agent's CLI adapter to build the invocation.
        new_session_id = None
        if mem.command:
            command = mem.command
        else:
            if not adapter.is_installed():
                raise RuntimeError(
                    f"{adapter.display_name} is not installed or not on PATH "
                    f"(command {adapter.command()!r}); install it or set {adapter.env_prefix}_COMMAND"
                )
            export_path = None
            if self.recorder is not None:
                sdir = self.recorder.session_dir(session.session_id)
                if sdir is not None:
                    export_path = str(
                        sdir / "traces" / agent_id / f"{mem.attempt_count + 1:04d}.json"
                    )
            if not resume_session_id:
                new_session_id = adapter.new_session_id()
            command = PTYManager.build_command(
                role.full_prompt(composed_prompt),
                resume_session_id=resume_session_id,
                export_path=export_path,
                model=mem.model,
                cli=adapter.name,
                cwd=mem.cwd,
                approval_mode=session.approval_mode.value,
                new_session_id=new_session_id,
            )
        launch_ctx = LaunchContext(prompt="", cwd=mem.cwd, approval_mode=session.approval_mode.value)
        env = adapter.prepare_env(os.environ.copy(), launch_ctx)
        sess = self.pty.create(agent_id, command, cwd=mem.cwd, project_id=session.session_id, env=env)
        sess.start()
        if self.recorder is not None:
            self.recorder.register_agent(session.session_id, agent_id, role.key)
        session.mark_started(agent_id)
        if new_session_id:
            # The CLI accepted an orchestrator-assigned id, so it is resumable
            # from the first byte (Claude Code --session-id).
            session.set_devin_session_id(agent_id, new_session_id)
        if mem.kind == "pipeline":
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
                "devin_model": mem.model or settings.devin_model,
                "cli": adapter.name,
                "model": mem.model or adapter.default_model(),
                "kind": mem.kind,
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

    def launch_auxiliary_agent(
        self, session: Session, agent_id: str, role: str, prompt: str,
        cwd: Optional[str] = None, model: Optional[str] = None,
        resume_session_id: Optional[str] = None, cli: Optional[str] = None,
    ) -> None:
        if session.get_agent(agent_id) is not None:
            raise RuntimeError(f"Agent {agent_id} already exists in session {session.session_id}")
        get_role(role)
        mem = session.add_agent(agent_id, role, kind="auxiliary", model=model, cli=cli)
        mem.cwd = cwd or session.workspace
        mem.extra_prompt = prompt
        session.persist_runtime()
        self.start_agent(session, agent_id, resume_session_id=resume_session_id)
        session.emit(Event(
            type="auxiliary_agent_launched", session_id=session.session_id,
            agent_id=agent_id, data={"role": role, "model": model or settings.devin_model,
                                     "cli": session.cli_for(agent_id)},
        ))

    def pause_agent(self, session: Session, agent_id: str) -> None:
        psess = self.pty.get(agent_id, session.session_id)
        if psess is None:
            raise RuntimeError(f"Agent {agent_id} is not running")
        psess.pause()
        run_key = self._run_key(session.session_id, agent_id)
        self._input_versions[run_key] = self._input_versions.get(run_key, 0) + 1
        session.set_status(agent_id, AgentStatus.paused)
        session.emit(Event(type="agent_paused", session_id=session.session_id, agent_id=agent_id))

    def resume_agent_process(self, session: Session, agent_id: str) -> None:
        psess = self.pty.get(agent_id, session.session_id)
        if psess is None:
            raise RuntimeError(f"Agent {agent_id} is not running")
        psess.resume()
        self._mark_input_progress(session, agent_id)
        session.emit(Event(type="agent_resumed", session_id=session.session_id, agent_id=agent_id))

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
        live = sess is not None and sess.is_alive()
        if mode == FeedbackMode.context or not live:
            session.add_feedback(agent_id, message, mode)
            event_type = "feedback_queued"
        else:
            self._prepare_manual_input(session, agent_id, sess)
            if mode == FeedbackMode.interrupt:
                sess.send_ctrl_c()
                time.sleep(0.3)
            sess.send_line(message)
            self._mark_input_progress(session, agent_id)
            event_type = "feedback_interrupt" if mode == FeedbackMode.interrupt else "feedback_injected"
            if arec:
                if mode == FeedbackMode.interrupt:
                    arec.record_action("send_ctrl_c", source="feedback")
                arec.record_action("send_line", text=message, source="feedback")
        session.emit(Event(
            type=event_type, session_id=session.session_id, agent_id=agent_id,
            data={"mode": mode.value, "message": message, "delivered": live and mode != FeedbackMode.context},
        ))
        if arec:
            arec.record_feedback(mode.value, message)

    def _prepare_manual_input(self, session: Session, agent_id: str, sess: PTYSession) -> None:
        mem = session.get_agent(agent_id)
        if mem and mem.pending_approval_question:
            raise RuntimeError("Resolve the pending approval before sending terminal input")
        if mem and mem.status == AgentStatus.paused:
            sess.resume()

    def _mark_input_progress(self, session: Session, agent_id: str) -> None:
        run_key = self._run_key(session.session_id, agent_id)
        self._input_versions[run_key] = self._input_versions.get(run_key, 0) + 1
        mem = session.get_agent(agent_id)
        if mem:
            mem.low_confidence_streak = 0
            mem.idle_wait_streak = 0
            mem.attention = None
        idle = self._idle.get(self._run_key(session.session_id, agent_id))
        if idle:
            idle.reset()
        session.set_status(agent_id, AgentStatus.running)

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
        self._prepare_manual_input(session, agent_id, sess)
        self._apply_action(sess, action, text, key)
        self._mark_input_progress(session, agent_id)
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
        adapter = get_adapter(session.cli_for(agent_id))
        trusted_workspace = self._trusted_workspace(mem.cwd)
        last_startup_action_at = 0.0
        last_discovery_at = time.time()

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
            confirmation_menu_active = adapter.menu_state(visible_now).active
            if out:
                idle.update(sess)
                # Persist every raw byte the terminal emitted.
                arec = self._arec(session.session_id, agent_id)
                if arec:
                    arec.record_raw(out)
                # Harvest the resumable CLI session id from the PTY.
                if not mem.devin_session_id:
                    captured_id = None
                    if adapter.name == "devin":
                        trace_attempt = int(arec.attempt_id) if arec is not None else mem.attempt_count
                        captured_id = self._trace_session_id(session.session_id, agent_id, trace_attempt)
                        captured_id = captured_id or sess.devin_session_id
                    else:
                        captured_id = adapter.extract_session_id(sanitize_ansi(out))
                    if captured_id:
                        self._record_cli_session_id(session, agent_id, adapter.name, captured_id)
                # Emit a terminal_output event (throttled by the loop cadence).
                session.emit(Event(
                    type="terminal_output",
                    session_id=session.session_id,
                    agent_id=agent_id,
                    data=sanitize_ansi(out)[-512:],  # keep events small and readable
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
                    resume_id = mem.devin_session_id if adapter.capabilities.resume else None
                    try:
                        self.start_agent(
                            session, agent_id,
                            resume_session_id=resume_id if resume_id else None,
                        )
                    except Exception as exc:  # noqa: BLE001 - surface, don't kill silently
                        log.exception("Retry of agent %s failed", agent_id)
                        session.set_status(agent_id, AgentStatus.error)
                        session.emit(Event(
                            type="agent_died", session_id=session.session_id, agent_id=agent_id,
                            data={"retries_exhausted": False, "error": str(exc)[:500]},
                        ))
                        self._finalize_agent_summary(session, agent_id, status="error")
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

            # Paused agents still drain output and detect process exit, but do
            # not repeatedly call the controller or replay an escalation.
            if mem.status == AgentStatus.paused:
                stop_evt.wait(settings.poll_interval_s)
                continue

            # 2b. Known first-run dialogs (folder trust, self-update prompts) get
            # deterministic adapter answers; the LLM never sees them. Reached
            # only on iterations without new output, i.e. a settled screen.
            startup = adapter.startup_action(visible_now, trusted_workspace)
            if startup is not None:
                if time.time() - last_startup_action_at >= 1.0:
                    for key in startup.keys:
                        sess.send_text(key)
                    last_startup_action_at = time.time()
                    session.emit(Event(
                        type="adapter_startup_action", session_id=session.session_id,
                        agent_id=agent_id,
                        data={"cli": adapter.name, "description": startup.description,
                              "keys": list(startup.keys)},
                    ))
                    arec = self._arec(session.session_id, agent_id)
                    if arec:
                        arec.record_action("send_text", text="".join(startup.keys), source="adapter")
                    idle.reset()
                stop_evt.wait(settings.poll_interval_s)
                continue

            # 2c. CLIs that do not print their session id are polled for it.
            if (
                not mem.devin_session_id
                and adapter.name != "devin"
                and adapter.capabilities.session_id_capture
                and time.time() - last_discovery_at >= _DISCOVERY_INTERVAL_S
            ):
                last_discovery_at = time.time()
                try:
                    found = adapter.discover_session_id(mem.cwd, mem.started_at)
                except Exception:  # noqa: BLE001 - discovery is best-effort
                    log.exception("Session discovery failed for %s", agent_id)
                    found = None
                if found:
                    self._record_cli_session_id(session, agent_id, adapter.name, found)

            # 3. Sample screen stability even when no new bytes arrive. Quiet
            # prompts are stable precisely because read_available() returned empty.
            idle.update(sess)
            # Not idle yet? Short sleep and re-poll.
            if not confirmation_menu_active and (adapter.busy(visible_now) or not idle.is_idle(sess)):
                time.sleep(settings.poll_interval_s)
                continue

            # 4. Idle -> ask the controller what to do.
            snapshot = session.snapshot_for_controller(agent_id)
            snapshot["agent_cli"] = adapter.display_name
            if adapter.controller_guidance:
                snapshot["cli_guidance"] = adapter.controller_guidance
            visible = sess.capture_visible_screen()
            recent = sess.recent_output(20)
            run_key = self._run_key(session.session_id, agent_id)
            input_version = self._input_versions.get(run_key, 0)
            decision = self.controller.decide(snapshot, visible, recent)
            if stop_evt.is_set():
                return
            if self._input_versions.get(run_key, 0) != input_version:
                # A human acted while the network call was in flight. Its old
                # terminal snapshot can no longer authorize input or a pause.
                session.emit(Event(type="controller_decision_discarded",
                    session_id=session.session_id, agent_id=agent_id,
                    data={"reason": "manual input or pause changed the terminal"}))
                continue
            if not decision.reason.startswith("controller error:"):
                session.drain_feedback(agent_id)
            else:
                session.emit(Event(
                    type="controller_error", session_id=session.session_id,
                    agent_id=agent_id, data={"reason": decision.reason,
                    "retrying": decision.action == ActionType.wait},
                ))
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

            # Controller errors have their own bounded retry budget.
            if decision.reason.startswith("controller error:") and decision.action == ActionType.wait:
                stop_evt.wait((decision.duration_ms or 1000) / 1000.0)
                idle.reset()
                continue

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
                    screen_excerpt=adapter.menu_state(visible).excerpt,
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

            # 7. Execute the one action. Any typed answer resolves an
            # outstanding agent question.
            if decision.action in (ActionType.send_line, ActionType.send_text) and mem.attention:
                session.set_attention(agent_id, None)
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

    def _record_cli_session_id(self, session: Session, agent_id: str, cli: str, cli_session_id: str) -> None:
        session.set_devin_session_id(agent_id, cli_session_id)
        session.emit(Event(
            type="cli_session_captured", session_id=session.session_id, agent_id=agent_id,
            data={"cli": cli, "session_id": cli_session_id},
        ))

    def _export_cli_trace(self, session: Session, agent_id: str) -> None:
        """Copy a non-Devin CLI's own transcript next to the PTY recordings.

        Devin writes its trace through --export at launch. Other CLIs keep
        transcripts in their own stores, copied here in the background so an
        HTTP stop request never waits on a subprocess.
        """
        mem = session.get_agent(agent_id)
        if self.recorder is None or mem is None or not mem.devin_session_id or mem.command:
            return
        adapter = get_adapter(session.cli_for(agent_id))
        if adapter.name == "devin" or not adapter.capabilities.trace_export:
            return
        sdir = self.recorder.session_dir(session.session_id)
        if sdir is None:
            return
        dest = sdir / "traces" / agent_id / f"{max(mem.attempt_count, 1):04d}.{adapter.name}.json"
        cli_session_id, cwd = mem.devin_session_id, mem.cwd

        def _run() -> None:
            try:
                if adapter.export_trace(cli_session_id, cwd, dest):
                    session.emit(Event(
                        type="cli_trace_exported", session_id=session.session_id, agent_id=agent_id,
                        data={"cli": adapter.name, "path": str(dest)},
                    ))
            except Exception:  # noqa: BLE001 - best-effort
                log.exception("Trace export failed for %s", agent_id)

        threading.Thread(target=_run, name=f"trace-{agent_id}", daemon=True).start()

    def _finalize_agent_summary(self, session: Session, agent_id: str, status: str) -> None:
        """Write the agent's summary.json with its final state + stats."""
        if self.recorder is None:
            return
        self._export_cli_trace(session, agent_id)
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
                "cli": session.cli_for(agent_id),
                "cli_session_id": mem.devin_session_id,
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
        # Plain streaming CLIs (Devin) leave markers in the raw scrollback;
        # redraw-style TUIs (Claude Code, OpenCode, Codex) position text with
        # cursor moves, so markers only exist on the rendered screen.
        recent = sess.recent_output(30) + "\n" + sess.capture_visible_screen()

        # AGENT_DONE is valid only for the active work role and current stage.
        m = _DONE_RE.search(recent)
        if m:
            stage = m.group(1).lower()
            if mem.kind == "auxiliary" and stage == mem.role:
                self.pty.remove(agent_id, force=True, project_id=session.session_id)
                session.set_summary(agent_id, f"Auxiliary task {stage} reported done.")
                session.set_status(agent_id, AgentStatus.done)
                session.emit(Event(type="auxiliary_agent_done", session_id=session.session_id,
                                   agent_id=agent_id, data={"stage": stage}))
                self._finalize_agent_summary(session, agent_id, status="done")
                if self.recorder:
                    self.recorder.close_agent(session.session_id, agent_id)
                return
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
            mem.finished_at = time.time()
            self._finalize_agent_summary(session, agent_id, status="done")
            session.set_status(agent_id, AgentStatus.done)
            session.emit(Event(
                type="agent_done",
                session_id=session.session_id,
                agent_id=agent_id,
                data={"stage": stage},
            ))
            if self.recorder:
                self.recorder.close_agent(session.session_id, agent_id)
            return

        # AGENT_QUESTION: report each distinct question once. It stays on a
        # TUI's screen for many output chunks, and must not block the gate
        # verdict checks below.
        m = _QUESTION_RE.search(recent)
        run_key = self._run_key(session.session_id, agent_id)
        if m:
            question = m.group(1).strip()
            if self._last_question.get(run_key) != question:
                self._last_question[run_key] = question
                session.set_attention(agent_id, question)
                session.emit(Event(
                    type="agent_question",
                    session_id=session.session_id,
                    agent_id=agent_id,
                    data={"question": question},
                ))
                session.emit(Event(
                    type="agent_attention",
                    session_id=session.session_id,
                    agent_id=agent_id,
                    data={"question": question, "source": "agent"},
                ))

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
                    f"Completion was not accepted. Verify all artifacts, then print exactly "
                    f"`AGENT_DONE {stage}` on its own line, without the backticks."
                )
            return
        if decision.action == ActionType.terminate:
            self.stop_agent(session, agent_id)
            return
        if decision.action == ActionType.ask_human:
            session.set_attention(agent_id, decision.reason)
            session.set_status(agent_id, AgentStatus.paused)
            session.emit(Event(
                type="agent_attention",
                session_id=session.session_id,
                agent_id=agent_id,
                data={"question": decision.reason, "risk": decision.risk.value},
            ))
            # Legacy event name kept for existing consumers.
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
                        f"`APPROVE {reviewed_stage}` or `REJECT {reviewed_stage}: <actionable reasons>` "
                        "on its own line, without the backticks."
                    )
            return
        # Terminal keystroke actions.
        if sess and sess.is_alive():
            menu = get_adapter(session.cli_for(agent_id)).menu_state(sess.capture_visible_screen())
            confirms_menu = (
                decision.action == ActionType.press_enter
                or (
                    decision.action == ActionType.press_key
                    and (decision.key or "").lower() in {"1", "enter", "return"}
                )
            )
            if menu.active and confirms_menu:
                # Only a highlighted one-time approval may be confirmed; never a
                # "don't ask again"/"allow always" option.
                if menu.approve_selected:
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

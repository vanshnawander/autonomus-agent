"""Session store + structured memory.

For each pipeline run we keep:

  - goal, constraints, human feedback queue
  - per-agent summaries, status, last decision, devin session id
  - the ordered pipeline and current stage pointer
  - an event log (for the /events SSE stream)
  - handoff history (who handed off to whom and why)

We do NOT pass the full terminal history into the LLM every turn — we keep raw
logs on the PTYSession and send the controller a compact snapshot.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from threading import Lock
from typing import Optional

from .schemas import ApprovalMode

from .schemas import (
    AgentStatus,
    ControllerDecision,
    Event,
    FeedbackMode,
)
from .config import settings
from .roles import build_pipeline
from .recorder import Recorder


@dataclass
class AgentMemory:
    agent_id: str
    role: str
    status: AgentStatus = AgentStatus.idle
    summary: str = ""
    last_decision: Optional[ControllerDecision] = None
    devin_session_id: Optional[str] = None
    pending_feedback: list[str] = field(default_factory=list)
    pending_approval_question: Optional[str] = None
    # How many consecutive low-confidence waits we've seen (for escalation).
    low_confidence_streak: int = 0
    # How many consecutive idle->wait decisions without any text input (stuck
    # detection). Reset whenever a non-wait action is executed.
    idle_wait_streak: int = 0
    # How many times this agent has been retried after dying unexpectedly.
    retry_count: int = 0
    attempt_count: int = 0
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    # Optional override for the spawn command (from AgentSpec.command). When set,
    # start_agent uses this verbatim instead of building a `devin` invocation.
    command: Optional[str] = None
    # Optional working directory override (from AgentSpec.cwd).
    cwd: Optional[str] = None


@dataclass
class HandoffRecord:
    from_agent: str
    to_agent: str
    reason: str
    timestamp: float = field(default_factory=time.time)


@dataclass
class Session:
    session_id: str
    goal: str
    constraints: list[str] = field(default_factory=list)
    approval_mode: ApprovalMode = ApprovalMode.manual
    workspace: Optional[str] = None
    project_brief_path: Optional[str] = None
    project_brief_sha256: Optional[str] = None
    agents: dict[str, AgentMemory] = field(default_factory=dict)
    # Ordered list of role keys that make up this run (subset of PIPELINE).
    pipeline: list[str] = field(default_factory=list)
    stage_index: int = 0
    active_agent: Optional[str] = None
    done: bool = False
    events: list[Event] = field(default_factory=list)
    handoffs: list[HandoffRecord] = field(default_factory=list)
    # Optional recorder; when set, every event + handoff is also persisted.
    recorder: Optional[Recorder] = None
    _lock: Lock = field(default_factory=Lock, repr=False)

    def persist_runtime(self) -> None:
        if self.recorder is None:
            return
        self.recorder.update_manifest(self.session_id, {
            "stage_index": self.stage_index,
            "active_agent": self.active_agent,
            "done": self.done,
            "updated_at": time.time(),
            "agents_runtime": {
                aid: {
                    "status": mem.status.value,
                    "devin_session_id": mem.devin_session_id,
                    "attempt_count": mem.attempt_count,
                    "retry_count": mem.retry_count,
                    "started_at": mem.started_at,
                    "finished_at": mem.finished_at,
                }
                for aid, mem in self.agents.items()
            },
        })

    # ------------------------------------------------------------------ events

    def emit(self, event: Event) -> None:
        if event.timestamp == 0.0:
            event.timestamp = time.time()
        with self._lock:
            self.events.append(event)
            # Keep the in-memory event log bounded.
            if len(self.events) > 2000:
                self.events = self.events[-1000:]
        if self.recorder is not None:
            try:
                self.recorder.record_event(self.session_id, event.model_dump())
            except Exception:
                pass

    def recent_events(self, n: int = 100) -> list[Event]:
        with self._lock:
            return list(self.events[-n:])

    # ------------------------------------------------------------------ agents

    def add_agent(self, agent_id: str, role: str) -> AgentMemory:
        with self._lock:
            mem = AgentMemory(agent_id=agent_id, role=role)
            self.agents[agent_id] = mem
            return mem

    def get_agent(self, agent_id: str) -> Optional[AgentMemory]:
        return self.agents.get(agent_id)

    def set_status(self, agent_id: str, status: AgentStatus) -> None:
        with self._lock:
            mem = self.agents.get(agent_id)
            if mem:
                mem.status = status
                if status == AgentStatus.running:
                    mem.attempt_count += 1
                    mem.started_at = time.time()
                    mem.finished_at = None
                    mem.low_confidence_streak = 0
                    mem.idle_wait_streak = 0
                if status in (AgentStatus.done, AgentStatus.stopped, AgentStatus.error):
                    mem.finished_at = time.time()
        self.persist_runtime()

    def set_summary(self, agent_id: str, summary: str) -> None:
        with self._lock:
            mem = self.agents.get(agent_id)
            if mem:
                mem.summary = summary

    def set_last_decision(self, agent_id: str, decision: ControllerDecision) -> None:
        with self._lock:
            mem = self.agents.get(agent_id)
            if mem:
                mem.last_decision = decision

    def set_devin_session_id(self, agent_id: str, devin_id: Optional[str]) -> None:
        with self._lock:
            mem = self.agents.get(agent_id)
            if mem:
                mem.devin_session_id = devin_id
        self.persist_runtime()

    # ------------------------------------------------------------------ feedback

    def add_feedback(self, agent_id: str, message: str, mode: FeedbackMode) -> None:
        with self._lock:
            mem = self.agents.get(agent_id)
            if mem:
                # Context feedback is queued for the controller to use next turn.
                mem.pending_feedback.append(f"[{mode.value}] {message}")

    def drain_feedback(self, agent_id: str) -> list[str]:
        with self._lock:
            mem = self.agents.get(agent_id)
            if not mem:
                return []
            fb = list(mem.pending_feedback)
            mem.pending_feedback.clear()
            return fb

    # ------------------------------------------------------------------ pipeline

    def current_stage(self) -> Optional[str]:
        if self.stage_index >= len(self.pipeline):
            return None
        return self.pipeline[self.stage_index]

    def advance_stage(self) -> Optional[str]:
        with self._lock:
            self.stage_index += 1
            if self.stage_index >= len(self.pipeline):
                self.done = True
                next_stage = None
            else:
                next_stage = self.pipeline[self.stage_index]
        self.persist_runtime()
        return next_stage

    def record_handoff(self, from_agent: str, to_agent: str, reason: str) -> None:
        rec = HandoffRecord(from_agent=from_agent, to_agent=to_agent, reason=reason)
        with self._lock:
            self.handoffs.append(rec)
        if self.recorder is not None:
            try:
                self.recorder.record_handoff(self.session_id, {
                    "from_agent": rec.from_agent,
                    "to_agent": rec.to_agent,
                    "reason": rec.reason,
                    "timestamp": rec.timestamp,
                })
            except Exception:
                pass
        self.persist_runtime()

    # ------------------------------------------------------------------ snapshot

    def snapshot_for_controller(self, agent_id: str) -> dict:
        """Build the compact state dict we send to the LLM controller."""
        mem = self.get_agent(agent_id)
        if mem is None:
            return {}
        other = {
            aid: {"status": m.status.value, "last_summary": m.summary}
            for aid, m in self.agents.items()
            if aid != agent_id
        }
        return {
            "session_id": self.session_id,
            "agent_id": agent_id,
            "agent_role": mem.role,
            "goal": self.goal,
            "constraints": list(self.constraints),
            "current_stage": self.current_stage(),
            "pipeline": list(self.pipeline),
            "stage_index": self.stage_index,
            "human_feedback": list(mem.pending_feedback),
            "other_agents": other,
            "agent_summary": mem.summary,
        }


class SessionStore:
    """Registry of all pipeline runs."""

    def __init__(self, recorder: Optional[Recorder] = None) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = Lock()
        self.recorder = recorder

    def set_recorder(self, recorder: Recorder) -> None:
        self.recorder = recorder

    def create(
        self,
        session_id: str,
        goal: str,
        constraints: list[str],
        agent_specs: list[tuple[str, str, Optional[str], Optional[str]]],
        approval_mode: ApprovalMode = ApprovalMode.manual,
        workspace: Optional[str] = None,
        project_brief_path: Optional[str] = None,
        project_brief_sha256: Optional[str] = None,
    ) -> Session:
        """agent_specs is a list of (agent_id, role_key, command_override, cwd).

        command_override and cwd may be None to use the default `devin` command.
        """
        with self._lock:
            if session_id in self._sessions:
                raise RuntimeError(f"Session {session_id} already exists")
            # Build the ordered pipeline: each declared work stage followed by a
            # reviewer gate (if the reviewer role is declared).
            declared_roles = {role for _aid, role, _c, _w in agent_specs}
            pipeline = build_pipeline(declared_roles)
            sess = Session(
                session_id=session_id,
                goal=goal,
                constraints=list(constraints),
                pipeline=pipeline,
                approval_mode=approval_mode,
                workspace=workspace,
                project_brief_path=project_brief_path,
                project_brief_sha256=project_brief_sha256,
            )
            for aid, role, cmd, cwd in agent_specs:
                mem = sess.add_agent(aid, role)
                mem.command = cmd
                mem.cwd = cwd
            self._sessions[session_id] = sess
            # Register with the recorder so everything from here on is persisted.
            if self.recorder is not None:
                sess.recorder = self.recorder
                self.recorder.register_session(session_id, {
                    "session_id": session_id,
                    "goal": goal,
                    "constraints": list(constraints),
                    "pipeline": pipeline,
                    "approval_mode": approval_mode.value,
                    "workspace": workspace,
                    "project_brief_path": project_brief_path,
                    "project_brief_sha256": project_brief_sha256,
                    "orchestrator_model": settings.llm_model,
                    "devin_model": settings.devin_model,
                    "agents": {aid: {"role": m.role, "command": m.command, "cwd": m.cwd}
                               for aid, m in sess.agents.items()},
                    "stage_index": 0,
                    "active_agent": None,
                    "done": False,
                    "agents_runtime": {},
                    "created_at": time.time(),
                })
            return sess

    def restore(self, session_id: str) -> Session:
        """Reconstruct a stopped session from its persisted manifest."""
        if self.recorder is None:
            raise RuntimeError("recorder is not configured")
        sdir = self.recorder.session_dir(session_id)
        manifest_path = sdir / "manifest.json" if sdir else None
        if manifest_path is None or not manifest_path.exists():
            raise RuntimeError(f"recorded session {session_id} not found")
        import json
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        with self._lock:
            existing = self._sessions.get(session_id)
            if existing is not None:
                return existing
            sess = Session(
                session_id=session_id,
                goal=str(manifest.get("goal", "")),
                constraints=list(manifest.get("constraints", [])),
                pipeline=list(manifest.get("pipeline", [])),
                stage_index=int(manifest.get("stage_index", 0)),
                active_agent=manifest.get("active_agent"),
                done=bool(manifest.get("done", False)),
                approval_mode=ApprovalMode(manifest.get("approval_mode", "manual")),
                workspace=manifest.get("workspace"),
                project_brief_path=manifest.get("project_brief_path"),
                project_brief_sha256=manifest.get("project_brief_sha256"),
                recorder=self.recorder,
            )
            runtime = manifest.get("agents_runtime", {}) or {}
            for aid, spec in (manifest.get("agents", {}) or {}).items():
                mem = sess.add_agent(aid, str(spec["role"]))
                mem.command = spec.get("command")
                mem.cwd = spec.get("cwd")
                state = runtime.get(aid, {}) or {}
                prior_status = state.get("status", "idle")
                mem.status = (
                    AgentStatus(prior_status)
                    if prior_status in {"done", "error", "stopped", "idle"}
                    else AgentStatus.stopped
                )
                mem.devin_session_id = state.get("devin_session_id")
                mem.attempt_count = int(state.get("attempt_count", 0))
                mem.retry_count = int(state.get("retry_count", 0))
                mem.started_at = state.get("started_at")
                mem.finished_at = state.get("finished_at")
            self._sessions[session_id] = sess
            return sess

    def get(self, session_id: str) -> Optional[Session]:
        return self._sessions.get(session_id)

    def all(self) -> dict[str, Session]:
        return dict(self._sessions)

    def remove(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

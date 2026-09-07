"""FastAPI app exposing the orchestrator.

Endpoints:
  POST   /sessions                                 create + start a pipeline
  GET    /sessions                                  list sessions
  GET    /sessions/{sid}                            session state
  DELETE /sessions/{sid}                            stop + remove a session
  POST   /sessions/{sid}/feedback                   send human feedback
  POST   /sessions/{sid}/agents/{aid}/input         force input (manual override)
  GET    /sessions/{sid}/agents/{aid}/screen        visible terminal screen
  POST   /sessions/{sid}/agents/{aid}/restart       restart / resume an agent
  POST   /sessions/{sid}/resume                     restore a recorded run after restart/power loss
  POST   /sessions/{sid}/agents/{aid}/resize        resize the agent's terminal
  GET    /sessions/{sid}/approvals                  pending approvals
  POST   /sessions/{sid}/approvals/{apid}           resolve an approval
  GET    /sessions/{sid}/events                     SSE stream of events
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .control_loop import Orchestrator
from .pty_manager import PTYManager
from .recorder import Recorder
from .searxng import search as searxng_search
from .server_inventory import redacted_inventory
from .roles import get_role
from .safety import SafetyGate
from .schemas import (
    AgentStateResponse,
    AgentStatus,
    ApprovalRequest,
    CreateSessionRequest,
    Event,
    FeedbackRequest,
    ForceInputRequest,
    LaunchAuxiliaryAgentRequest,
    SessionResponse,
    SessionSummary,
)
from .session_store import SessionStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("orchestrator.app")


def _events_after_cursor(events: list[Event], cursor: Optional[str]) -> list[Event]:
    """Return strictly newer events; replay the bounded buffer for an unknown cursor."""
    if not cursor:
        return events
    ids = [event.event_id for event in events]
    try:
        return events[ids.index(cursor) + 1:]
    except ValueError:
        return events


def build_app() -> FastAPI:
    recorder = Recorder()
    pty_manager = PTYManager()
    sessions = SessionStore(recorder=recorder)
    safety = SafetyGate(allow_auto_approve=settings.allow_auto_approve)
    orch = Orchestrator(pty_manager, sessions, safety, recorder=recorder)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        orch.shutdown()

    app = FastAPI(title="Devin CLI Orchestrator", version="0.1.0", lifespan=lifespan)

    # Serve the React dashboard build (dashboard/dist). In development, run
    # `npm run dev` inside dashboard/ and open the Vite dev server instead.
    dashboard_dir = Path(__file__).resolve().parent.parent / "dashboard" / "dist"
    if dashboard_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(dashboard_dir / "assets")), name="assets")

        @app.get("/", include_in_schema=False)
        def dashboard_root():
            return FileResponse(str(dashboard_dir / "index.html"))

        @app.get("/favicon.svg", include_in_schema=False)
        def dashboard_favicon():
            f = dashboard_dir / "favicon.svg"
            if f.is_file():
                return FileResponse(str(f))
            raise HTTPException(status_code=404)

    # ------------------------------------------------------------------ helpers

    def _session_or_404(sid: str):
        s = sessions.get(sid)
        if s is None:
            try:
                s = sessions.restore(sid)
            except (RuntimeError, ValueError, KeyError, json.JSONDecodeError):
                raise HTTPException(status_code=404, detail=f"session {sid} not found")
        return s

    def _recording_dir_or_404(sid: str, aid: str, attempt_id: Optional[str] = None):
        if attempt_id is not None:
            if not attempt_id.isdigit():
                raise HTTPException(status_code=400, detail="attempt_id must be numeric")
            sdir = recorder.session_dir(sid)
            path = sdir / "agents" / aid / "sessions" / attempt_id if sdir else None
            if path is None or not path.is_dir():
                raise HTTPException(status_code=404, detail=f"recording attempt {attempt_id} not found")
            return path
        path = recorder.latest_agent_dir(sid, aid)
        if path is None:
            raise HTTPException(status_code=404, detail=f"no recorded invocation for agent {aid}")
        return path

    def _agent_state_response(sid: str, aid: str) -> AgentStateResponse:
        s = _session_or_404(sid)
        mem = s.get_agent(aid)
        if mem is None:
            raise HTTPException(status_code=404, detail=f"agent {aid} not in session {sid}")
        psess = pty_manager.get(aid, sid)
        visible = psess.capture_visible_screen() if psess else ""
        recent = psess.recent_output(20) if psess else ""
        pending = safety.pending_for_agent(sid, aid)
        alive = bool(psess and psess.is_alive())
        return AgentStateResponse(
            agent_id=aid,
            role=mem.role,
            status=mem.status,
            visible_screen=visible,
            recent_output=recent,
            last_decision=mem.last_decision,
            devin_session_id=mem.devin_session_id,
            pending_approval=pending.question if pending else None,
            kind=mem.kind,
            model=mem.model or settings.devin_model,
            started_at=mem.started_at,
            finished_at=mem.finished_at,
            alive=alive,
        )

    def _active_agents(s) -> list[str]:
        return sorted(
            aid for aid in s.agents
            if (psess := pty_manager.get(aid, s.session_id)) is not None and psess.is_alive()
        )

    def _session_response(s) -> SessionResponse:
        return SessionResponse(
            session_id=s.session_id, goal=s.goal,
            agents={aid: _agent_state_response(s.session_id, aid) for aid in s.agents},
            active_agent=s.active_agent, active_agents=_active_agents(s),
            done=s.done, approval_mode=s.approval_mode, workspace=s.workspace,
            pipeline=s.pipeline, stage_index=s.stage_index,
        )

    def _prepare_workspace(req: CreateSessionRequest) -> tuple[Path, Path, str]:
        root = settings.workspace_root.resolve()
        requested = Path(req.workspace or req.session_id)
        if requested.is_absolute():
            raise HTTPException(status_code=400, detail="workspace must be relative to DEVIN_ORCH_WORKSPACE_ROOT")
        workspace = (root / requested).resolve()
        try:
            workspace.relative_to(root)
        except ValueError:
            raise HTTPException(status_code=400, detail="workspace escapes DEVIN_ORCH_WORKSPACE_ROOT")
        workspace.mkdir(parents=True, exist_ok=True)
        brief = req.project_brief or (
            f"# Project Brief\n\n## Goal\n{req.goal}\n\n## Constraints\n"
            + ("\n".join(f"- {item}" for item in req.constraints) or "- None declared")
            + "\n"
        )
        brief_path = workspace / "PROJECT_BRIEF.md"
        if brief_path.exists() and brief_path.read_text(encoding="utf-8") != brief:
            raise HTTPException(status_code=409, detail="PROJECT_BRIEF.md already exists with different content")
        if not brief_path.exists():
            pending = workspace / ".PROJECT_BRIEF.md.pending"
            pending.write_text(brief, encoding="utf-8")
            pending.replace(brief_path)
        digest = hashlib.sha256(brief.encode("utf-8")).hexdigest()
        return workspace, brief_path, digest

    def _latest_trace_session_id(sid: str, aid: str) -> Optional[str]:
        sdir = recorder.session_dir(sid)
        trace_dir = sdir / "traces" / aid if sdir else None
        traces = sorted(trace_dir.glob("*.json")) if trace_dir and trace_dir.is_dir() else []
        for path in reversed(traces):
            try:
                value = json.loads(path.read_text(encoding="utf-8")).get("session_id")
            except (OSError, json.JSONDecodeError, AttributeError):
                continue
            if isinstance(value, str) and value and all(c.isalnum() or c in "-_" for c in value):
                return value
        return None

    # ------------------------------------------------------------------ sessions

    @app.post("/sessions", response_model=SessionResponse)
    def create_session(req: CreateSessionRequest) -> SessionResponse:
        agent_ids = [a.agent_id for a in req.agents]
        if len(agent_ids) != len(set(agent_ids)):
            raise HTTPException(status_code=400, detail="agent_id values must be unique within a session")
        agent_roles = [agent.role for agent in req.agents]
        if len(agent_roles) != len(set(agent_roles)):
            raise HTTPException(status_code=400, detail="only one agent may own each pipeline role")

        for spec in req.agents:
            try:
                get_role(spec.role)
            except KeyError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
        if req.approval_mode.value == "autonomous" and (not settings.llm_api_key or settings.llm_api_key == "missing"):
            raise HTTPException(status_code=400, detail="autonomous mode requires DEVIN_ORCH_LLM_API_KEY or OPENROUTER_API_KEY")
        workspace, brief_path, brief_sha256 = _prepare_workspace(req)
        root = settings.workspace_root.resolve()
        for spec in req.agents:
            if spec.cwd is None:
                spec.cwd = str(workspace)
                continue
            candidate = Path(spec.cwd).resolve()
            try:
                candidate.relative_to(root)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"agent cwd escapes workspace root: {spec.cwd}")
            if not candidate.is_dir():
                raise HTTPException(status_code=400, detail=f"agent cwd does not exist: {spec.cwd}")
            spec.cwd = str(candidate)
        try:
            sess = sessions.create(
                req.session_id,
                req.goal,
                req.constraints,
                [(a.agent_id, a.role, a.command, a.cwd, a.extra_prompt) for a in req.agents],
                approval_mode=req.approval_mode,
                workspace=str(workspace),
                project_brief_path=str(brief_path),
                project_brief_sha256=brief_sha256,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        except KeyError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        # Spawn the first stage of the pipeline.
        first_stage = sess.current_stage()
        if first_stage:
            # Find the agent_id whose role matches the first stage.
            first_agent = next(
                (a.agent_id for a in req.agents if a.role == first_stage),
                None,
            )
            if first_agent is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"first pipeline stage {first_stage!r} has no matching agent",
                )
            spec = next(a for a in req.agents if a.agent_id == first_agent)
            orch.start_agent(
                sess, first_agent,
                resume_session_id=spec.resume_session_id,
            )
        return _session_response(sess)

    @app.get("/sessions")
    def list_sessions() -> list[SessionResponse]:
        out = []
        for sid, s in sessions.all().items():
            out.append(_session_response(s))
        return out

    @app.get("/sessions/all", response_model=list[SessionSummary])
    def list_all_sessions() -> list[SessionSummary]:
        """Unified list merging live (in-memory) and recorded (on-disk) sessions.

        The dashboard sidebar uses this so past runs survive orchestrator
        restarts. Live sessions win on key conflicts; their richer state is
        preserved. Recorded-only sessions get goal/agents/counts from the
        manifest + events file on disk.
        """
        out: dict[str, SessionSummary] = {}
        # Recorded sessions first (so live state can override below).
        for rec in recorder.list_sessions():
            sid = rec["session_id"]
            manifest = rec.get("manifest", {}) or {}
            agent_roles: list[str] = []
            agents_meta = manifest.get("agents", {}) or {}
            if isinstance(agents_meta, dict):
                for ainfo in agents_meta.values():
                    if isinstance(ainfo, dict) and "role" in ainfo:
                        agent_roles.append(str(ainfo["role"]))
            elif isinstance(agents_meta, list):
                for ainfo in agents_meta:
                    if isinstance(ainfo, dict) and "role" in ainfo:
                        agent_roles.append(str(ainfo["role"]))
            # Fallback: use the agents dir listing.
            if not agent_roles:
                agent_roles = list(rec.get("agents", []) or [])
            events_count = 0
            last_event_at: Optional[float] = None
            sdir = recorder.session_dir(sid)
            if sdir is not None:
                events_path = sdir / "events.jsonl"
                if events_path.exists():
                    try:
                        with events_path.open(encoding="utf-8", errors="replace") as f:
                            for line in f:
                                if not line.strip():
                                    continue
                                events_count += 1
                                try:
                                    ev = json.loads(line)
                                    ts = ev.get("timestamp")
                                    if isinstance(ts, (int, float)) and (
                                        last_event_at is None or ts > last_event_at
                                    ):
                                        last_event_at = float(ts)
                                except json.JSONDecodeError:
                                    continue
                    except OSError:
                        pass
            out[sid] = SessionSummary(
                session_id=sid,
                goal=str(manifest.get("goal", "") or ""),
                active_agent=None,
                done=bool(manifest.get("done", False)),
                live=False,
                agent_roles=agent_roles,
                agent_count=len(agent_roles),
                events_count=events_count,
                created_at=float(manifest["created_at"]) if manifest.get("created_at") else None,
                last_event_at=last_event_at,
                approval_mode=manifest.get("approval_mode", "manual"),
                workspace=manifest.get("workspace"),
                pipeline=list(manifest.get("pipeline", [])),
                stage_index=int(manifest.get("stage_index", 0)),
            )
        # Live sessions override / supplement.
        for sid, s in sessions.all().items():
            live_roles = [m.role for m in s.agents.values()]
            existing = out.get(sid)
            live_summary = SessionSummary(
                session_id=sid,
                goal=s.goal,
                active_agent=s.active_agent,
                done=s.done,
                live=bool(_active_agents(s)),
                agent_roles=live_roles or (existing.agent_roles if existing else []),
                agent_count=len(s.agents) or (existing.agent_count if existing else 0),
                events_count=len(s.events),
                created_at=existing.created_at if existing else None,
                last_event_at=s.events[-1].timestamp if s.events else (existing.last_event_at if existing else None),
                approval_mode=s.approval_mode,
                workspace=s.workspace,
                pipeline=s.pipeline,
                stage_index=s.stage_index,
            )
            out[sid] = live_summary
        # Newest first by last_event_at (fallback created_at, then name).
        def _key(item: SessionSummary) -> float:
            return item.last_event_at or item.created_at or 0.0

        return sorted(out.values(), key=_key, reverse=True)

    @app.get("/sessions/{sid}", response_model=SessionResponse)
    def get_session(sid: str) -> SessionResponse:
        s = _session_or_404(sid)
        return _session_response(s)

    @app.delete("/sessions/{sid}")
    def delete_session(sid: str) -> dict:
        s = _session_or_404(sid)
        for aid in list(s.agents):
            orch.stop_agent(s, aid)
        sessions.remove(sid)
        return {"deleted": sid}

    @app.post("/sessions/{sid}/resume", response_model=SessionResponse)
    def resume_session(sid: str, fresh_if_missing: bool = False) -> SessionResponse:
        s = _session_or_404(sid)
        if s.done:
            raise HTTPException(status_code=409, detail="completed sessions cannot be resumed")
        stage = s.current_stage()
        # active_agent is observational state and may be stale after a crash or
        # interrupted handoff. The persisted pipeline index is authoritative.
        target = next(
            (aid for aid, mem in s.agents.items() if mem.role == stage),
            None,
        )
        if target is None:
            raise HTTPException(status_code=409, detail="no resumable active stage")
        running = pty_manager.get(target, sid)
        if running is not None and running.is_alive():
            raise HTTPException(status_code=409, detail=f"agent {target} is already running")
        mem = s.get_agent(target)
        resume_id = (mem.devin_session_id if mem else None) or _latest_trace_session_id(sid, target)
        if resume_id and mem:
            s.set_devin_session_id(target, resume_id)
        if not resume_id and not fresh_if_missing:
            raise HTTPException(
                status_code=409,
                detail="no validated Devin history ID; retry with fresh_if_missing=true to restart the stage",
            )
        orch.start_agent(
            s, target, resume_session_id=resume_id,
            extra_prompt=(
                "Recover this interrupted stage from the persisted workspace and audit records. "
                "Inspect existing artifacts and logs before continuing; do not repeat completed work."
            ),
        )
        s.persist_runtime()
        return _session_response(s)

    @app.post("/sessions/{sid}/agents", response_model=AgentStateResponse)
    def launch_auxiliary_agent(sid: str, req: LaunchAuxiliaryAgentRequest) -> AgentStateResponse:
        s = _session_or_404(sid)
        try:
            get_role(req.role)
        except KeyError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        cwd = req.cwd or s.workspace
        if cwd:
            candidate = Path(cwd).resolve()
            try:
                candidate.relative_to(settings.workspace_root.resolve())
            except ValueError:
                raise HTTPException(status_code=400, detail="agent cwd escapes workspace root")
            if not candidate.is_dir():
                raise HTTPException(status_code=400, detail="agent cwd does not exist")
            cwd = str(candidate)
        try:
            orch.launch_auxiliary_agent(
                s, req.agent_id, req.role, req.prompt, cwd=cwd,
                model=req.model, resume_session_id=req.resume_session_id,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        return _agent_state_response(sid, req.agent_id)

    @app.post("/sessions/{sid}/agents/{aid}/pause")
    def pause_agent(sid: str, aid: str) -> dict:
        s = _session_or_404(sid)
        if aid not in s.agents:
            raise HTTPException(status_code=404, detail=f"agent {aid} not in session")
        try:
            orch.pause_agent(s, aid)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        return {"agent_id": aid, "status": "paused"}

    @app.post("/sessions/{sid}/agents/{aid}/resume-process")
    def resume_agent_process(sid: str, aid: str) -> dict:
        s = _session_or_404(sid)
        if aid not in s.agents:
            raise HTTPException(status_code=404, detail=f"agent {aid} not in session")
        try:
            orch.resume_agent_process(s, aid)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        return {"agent_id": aid, "status": "running"}

    @app.post("/sessions/{sid}/agents/{aid}/stop")
    def stop_managed_agent(sid: str, aid: str) -> dict:
        s = _session_or_404(sid)
        if aid not in s.agents:
            raise HTTPException(status_code=404, detail=f"agent {aid} not in session")
        orch.stop_agent(s, aid)
        return {"agent_id": aid, "status": "stopped"}

    # ------------------------------------------------------------------ feedback

    @app.post("/sessions/{sid}/feedback")
    def send_feedback(sid: str, req: FeedbackRequest) -> dict:
        s = _session_or_404(sid)
        target = req.target_agent or s.active_agent
        if target is None:
            raise HTTPException(status_code=400, detail="no target_agent and no active agent")
        if target not in s.agents:
            raise HTTPException(status_code=404, detail=f"agent {target} not in session")
        orch.inject_feedback(s, target, req.message, req.mode)
        return {"target_agent": target, "mode": req.mode.value}

    # ------------------------------------------------------------------ manual input

    @app.post("/sessions/{sid}/agents/{aid}/input")
    def force_input(sid: str, aid: str, req: ForceInputRequest) -> dict:
        s = _session_or_404(sid)
        if aid not in s.agents:
            raise HTTPException(status_code=404, detail=f"agent {aid} not in session")
        try:
            orch.force_input(s, aid, req.type, req.text, req.key)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        return {"agent_id": aid, "action": req.type.value}

    # ------------------------------------------------------------------ screen

    @app.get("/sessions/{sid}/agents/{aid}/screen", response_model=AgentStateResponse)
    def get_screen(sid: str, aid: str) -> AgentStateResponse:
        return _agent_state_response(sid, aid)

    # ------------------------------------------------------------------ restart / resume

    @app.post("/sessions/{sid}/agents/{aid}/restart")
    def restart_agent(
        sid: str,
        aid: str,
        resume: bool = True,
        extra_prompt: Optional[str] = None,
    ) -> dict:
        s = _session_or_404(sid)
        if aid not in s.agents:
            raise HTTPException(status_code=404, detail=f"agent {aid} not in session")
        orch.restart_agent(s, aid, resume=resume, extra_prompt=extra_prompt)
        return {"agent_id": aid, "restarted": True, "resume": resume}

    # ------------------------------------------------------------------ resize

    @app.post("/sessions/{sid}/agents/{aid}/resize")
    def resize_agent(sid: str, aid: str, cols: int = 120, rows: int = 40) -> dict:
        s = _session_or_404(sid)
        psess = pty_manager.get(aid, sid)
        if psess is None:
            raise HTTPException(status_code=404, detail=f"agent {aid} PTY not found")
        psess.resize(cols, rows)
        return {"agent_id": aid, "cols": cols, "rows": rows}

    # ------------------------------------------------------------------ approvals

    @app.get("/sessions/{sid}/approvals")
    def list_approvals(sid: str) -> list[dict]:
        _session_or_404(sid)
        return [a.model_dump() for a in safety.pending(session_id=sid)]

    @app.post("/sessions/{sid}/approvals/{apid}")
    def resolve_approval(sid: str, apid: str, req: ApprovalRequest) -> dict:
        s = _session_or_404(sid)
        item = safety.resolve(apid, req.approved, session_id=sid)
        if item is None:
            raise HTTPException(status_code=404, detail="approval not found or already resolved")
        s.emit(Event(
            type="human_approval_resolved",
            session_id=sid,
            agent_id=item.agent_id,
            data={"approval_id": apid, "approved": req.approved, "reason": req.reason},
        ))
        return {"approval_id": apid, "approved": req.approved}

    # ------------------------------------------------------------------ events (SSE)

    @app.get("/sessions/{sid}/events")
    async def stream_events(sid: str, last_event_id: Optional[str] = Header(None)):
        s = _session_or_404(sid)

        async def gen():
            cursor = last_event_id
            while True:
                events = s.recent_events(2000)
                events = _events_after_cursor(events, cursor)
                for ev in events:
                    payload = json.dumps(ev.model_dump(), default=str)
                    yield f"id: {ev.event_id}\ndata: {payload}\n\n"
                    cursor = ev.event_id
                await asyncio.sleep(0.5)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    # ------------------------------------------------------------------ global events (SSE)

    @app.get("/events")
    async def stream_all_events(last_event_id: Optional[str] = Header(None)):
        async def gen():
            cursor = last_event_id
            last_heartbeat = 0.0
            while True:
                events = sorted(
                    (ev for session in sessions.all().values() for ev in session.recent_events(2000)),
                    key=lambda ev: int((ev.event_id or ":0").rsplit(":", 1)[-1]),
                )
                events = _events_after_cursor(events, cursor)
                for ev in events:
                    payload = json.dumps(ev.model_dump(), default=str)
                    yield f"id: {ev.event_id}\ndata: {payload}\n\n"
                    cursor = ev.event_id
                now = time.time()
                if now - last_heartbeat >= 10:
                    yield f": heartbeat {now}\n\n"
                    last_heartbeat = now
                await asyncio.sleep(0.5)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    # ------------------------------------------------------------------ logs / recording

    @app.get("/logs")
    def list_recorded_sessions() -> list[dict]:
        """List every recorded session on disk (project-wise)."""
        return recorder.list_sessions()

    @app.get("/logs/{sid}")
    def get_recorded_session(sid: str) -> dict:
        """Session manifest + per-agent file listing."""
        sdir = recorder.session_dir(sid)
        if sdir is None:
            raise HTTPException(status_code=404, detail=f"no logs for session {sid}")
        agents = {}
        agents_dir = sdir / "agents"
        if agents_dir.exists():
            for ad in sorted(agents_dir.iterdir()):
                if ad.is_dir():
                    agents[ad.name] = recorder.list_agent_files(sid, ad.name)
        events_path = sdir / "events.jsonl"
        events_count = 0
        if events_path.exists():
            with events_path.open(encoding="utf-8", errors="replace") as f:
                events_count = sum(1 for line in f if line.strip())
        return {
            "session_id": sid,
            "path": str(sdir),
            "manifest": json.loads((sdir / "manifest.json").read_text()) if (sdir / "manifest.json").exists() else {},
            "agents": agents,
            "events_count": events_count,
            "events_file": str(events_path),
            "handoffs_file": str(sdir / "handoffs.jsonl"),
        }

    @app.get("/logs/{sid}/events")
    def get_recorded_events(sid: str, tail: Optional[int] = 100) -> list[dict]:
        return recorder.read_events(sid, tail=tail)

    @app.get("/logs/{sid}/handoffs")
    def get_recorded_handoffs(sid: str) -> list[dict]:
        return recorder.read_handoffs(sid)

    @app.get("/logs/{sid}/agents/{aid}/sessions")
    def list_agent_sessions(sid: str, aid: str) -> list[dict]:
        """List separately recorded invocations/retries/reviewer gates."""
        sdir = recorder.session_dir(sid)
        if sdir is None:
            raise HTTPException(status_code=404, detail="session not found")
        sessions_dir = sdir / "agents" / aid / "sessions"
        if not sessions_dir.exists():
            return []
        result = []
        for attempt in sorted(p for p in sessions_dir.iterdir() if p.is_dir()):
            files = {
                p.name: p.stat().st_size
                for p in attempt.iterdir()
                if p.is_file()
            }
            result.append({"attempt_id": attempt.name, "path": str(attempt), "files": files})
        return result

    @app.get("/logs/{sid}/agents/{aid}/raw")
    def get_agent_raw_log(
        sid: str, aid: str, tail_bytes: Optional[int] = None, attempt_id: Optional[str] = None,
    ) -> dict:
        """Raw PTY output for the selected (or latest) invocation."""
        raw_path = _recording_dir_or_404(sid, aid, attempt_id) / "raw.pty.log"
        if not raw_path.exists():
            raise HTTPException(status_code=404, detail="raw log not found")
        size = raw_path.stat().st_size
        if tail_bytes is None:
            content = raw_path.read_text(encoding="utf-8", errors="replace")
        else:
            with raw_path.open("rb") as f:
                f.seek(max(0, size - tail_bytes))
                content = f.read().decode("utf-8", errors="replace")
        return {"agent_id": aid, "attempt_id": raw_path.parent.name, "size_bytes": size, "content": content}

    @app.get("/logs/{sid}/agents/{aid}/audit")
    def get_agent_audit(
        sid: str, aid: str, tail: Optional[int] = 100, attempt_id: Optional[str] = None,
    ) -> list[dict]:
        from .recorder import _read_jsonl
        entries = _read_jsonl(_recording_dir_or_404(sid, aid, attempt_id) / "audit.jsonl", tail=tail)
        return [{**entry, "event": entry.get("event", entry.get("kind", "unknown"))} for entry in entries]

    @app.get("/logs/{sid}/agents/{aid}/screens")
    def get_agent_screens(
        sid: str, aid: str, tail: Optional[int] = 50, attempt_id: Optional[str] = None,
    ) -> list[dict]:
        from .recorder import _read_jsonl
        return _read_jsonl(_recording_dir_or_404(sid, aid, attempt_id) / "screen_snapshots.jsonl", tail=tail)

    @app.get("/logs/{sid}/agents/{aid}/controller")
    def get_agent_controller(
        sid: str, aid: str, tail: Optional[int] = 50, attempt_id: Optional[str] = None,
    ) -> list[dict]:
        from .recorder import _read_jsonl
        entries = _read_jsonl(_recording_dir_or_404(sid, aid, attempt_id) / "controller.jsonl", tail=tail)
        return [{**entry, "decision": entry.get("decision", entry.get("response"))} for entry in entries]

    @app.get("/logs/{sid}/agents/{aid}/feedback")
    def get_agent_feedback(sid: str, aid: str, attempt_id: Optional[str] = None) -> list[dict]:
        from .recorder import _read_jsonl
        return _read_jsonl(_recording_dir_or_404(sid, aid, attempt_id) / "feedback.jsonl")

    @app.get("/logs/{sid}/agents/{aid}/summary")
    def get_agent_summary(sid: str, aid: str, attempt_id: Optional[str] = None) -> dict:
        path = _recording_dir_or_404(sid, aid, attempt_id) / "summary.json"
        if not path.exists():
            raise HTTPException(status_code=404, detail="summary not written yet")
        return json.loads(path.read_text(encoding="utf-8"))

    @app.get("/logs/{sid}/agents/{aid}/live")
    async def stream_agent_live(sid: str, aid: str):
        """Live SSE stream of rendered terminal screens, not raw ANSI chunks."""
        s = _session_or_404(sid)
        if aid not in s.agents:
            raise HTTPException(status_code=404, detail=f"agent {aid} not in session")

        async def gen():
            last_screen: Optional[str] = None
            revision = 0
            last_heartbeat = time.monotonic()
            while True:
                psess = pty_manager.get(aid, sid)
                if psess is None:
                    yield f"data: {json.dumps({'type': 'eof'})}\n\n"
                    return
                screen = psess.capture_visible_screen()
                if screen != last_screen:
                    revision += 1
                    last_screen = screen
                    payload = {"type": "screen", "data": screen, "revision": revision}
                    yield f"id: {revision}\ndata: {json.dumps(payload)}\n\n"
                if not psess.is_alive():
                    yield f"data: {json.dumps({'type': 'eof'})}\n\n"
                    return
                now = time.monotonic()
                if now - last_heartbeat >= 10:
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
                    last_heartbeat = now
                await asyncio.sleep(0.3)

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ------------------------------------------------------------------ health

    @app.get("/preflight")
    def preflight() -> dict:
        checks = {
            "controller": {"ok": bool(settings.llm_api_key and settings.llm_api_key != "missing"), "detail": settings.llm_model},
            "devin": {"ok": shutil.which(settings.devin_command) is not None, "detail": settings.devin_command},
            "python": {"ok": Path(settings.python_executable).is_file(), "detail": settings.python_executable},
            "conda": {"ok": settings.conda_env == "research-agents", "detail": settings.conda_env or "not detected"},
            "workspace": {"ok": settings.workspace_root.is_dir() and os.access(settings.workspace_root, os.W_OK), "detail": str(settings.workspace_root)},
            "trace_export": {"ok": settings.devin_export_traces, "detail": "enabled" if settings.devin_export_traces else "disabled"},
        }
        try:
            searxng_search("orchestrator preflight", base_url=settings.searxng_url, limit=1, timeout=2)
            searx_ok = True
            searx_detail = settings.searxng_url
        except Exception as exc:
            searx_ok = False
            searx_detail = f"{settings.searxng_url}: {type(exc).__name__}"
        checks["searxng"] = {"ok": searx_ok, "detail": searx_detail}
        try:
            inventory = redacted_inventory(settings.server_inventory_file)
            password_auth = any(server["auth"] == "password" for server in inventory)
            inventory_ok = not password_auth or shutil.which("sshpass") is not None
            inventory_detail = f"{len(inventory)} server(s), secret-safe broker ready"
            if password_auth and not inventory_ok:
                inventory_detail += "; sshpass is missing"
        except (ValueError, OSError) as exc:
            inventory_ok = not settings.server_inventory_file.exists()
            inventory_detail = "optional; not configured" if inventory_ok else str(exc)
        checks["server_inventory"] = {"ok": inventory_ok, "detail": inventory_detail}
        required = ("controller", "devin", "python", "conda", "workspace", "trace_export", "searxng", "server_inventory")
        return {"ready": all(checks[name]["ok"] for name in required), "checks": checks}


    @app.get("/health")
    def health() -> dict:
        return {
            "status": "ok",
            "devin_command": settings.devin_command,
            "devin_model": settings.devin_model,
            "llm_model": settings.llm_model,
            "llm_max_tokens": settings.llm_max_tokens or None,
            "llm_configured": bool(settings.llm_api_key and settings.llm_api_key != "missing"),
            "auto_approve": settings.allow_auto_approve,
            "python_executable": settings.python_executable,
            "conda_env": settings.conda_env,
            "workspace_root": str(settings.workspace_root),
            "searxng_url": settings.searxng_url,
            "server_inventory_configured": settings.server_inventory_file.is_file(),
            "server_inventory_file": str(settings.server_inventory_file),
            "trace_export": settings.devin_export_traces,
            "sessions": len(sessions.all()),
        }

    # Stash refs for tests / smoke test.
    app.state.orch = orch
    app.state.sessions = sessions
    app.state.pty = pty_manager
    app.state.safety = safety
    app.state.recorder = recorder
    return app


app = build_app()


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()

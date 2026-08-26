"""Persistent recorder.

Everything that happens is written to disk, project-wise (per session) at the
top level and per-agent underneath. Layout:

    {log_dir}/
    └── {session_id}/                         # one directory per pipeline run
        ├── manifest.json                     # session metadata (goal, pipeline, agents)
        ├── events.jsonl                      # every event, one JSON object per line
        ├── handoffs.jsonl                    # every handoff record
        └── agents/
            └── {agent_id}/
                ├── raw.pty.log               # raw PTY bytes, append-only (what the
                │                             #   terminal actually emitted, incl. ANSI)
                ├── screen_snapshots.jsonl    # rendered visible screen over time
                ├── audit.jsonl               # every decision + executed action
                ├── controller.jsonl          # raw LLM controller request/response
                ├── feedback.jsonl            # every feedback injection
                └── summary.json              # agent metadata + final state

All jsonl files are append-only and line-buffered so you can `tail -f` them.
The raw PTY log is also append-only. A bounded in-memory ring buffer per agent
backs the live SSE tail endpoint.
"""
from __future__ import annotations

import json
import os
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .config import settings


def _append_jsonl(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")


def _read_jsonl(path: Path, tail: Optional[int] = None) -> list[dict]:
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    if tail is not None:
        lines = lines[-tail:]
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


@dataclass
class _AgentRecorder:
    """Per-agent file handles + ring buffer."""

    agent_id: str
    attempt_id: str
    dir: Path
    raw_path: Path
    screen_path: Path
    audit_path: Path
    controller_path: Path
    feedback_path: Path
    summary_path: Path
    _raw_fp: Any = None
    _lock: threading.Lock = field(default_factory=threading.Lock)
    # Bounded in-memory ring buffer for live tailing (raw output chunks).
    ring: deque = field(default_factory=lambda: deque(maxlen=200))
    # Bounded ring buffer of screen snapshots.
    screen_ring: deque = field(default_factory=lambda: deque(maxlen=50))
    # Bounded ring buffer of audit entries.
    audit_ring: deque = field(default_factory=lambda: deque(maxlen=200))

    def open(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        # Open the raw PTY log in binary append mode, line-buffered-ish.
        self._raw_fp = self.raw_path.open("ab")

    def close(self) -> None:
        with self._lock:
            if self._raw_fp is not None:
                try:
                    self._raw_fp.flush()
                    self._raw_fp.close()
                except Exception:
                    pass
                self._raw_fp = None

    # --------------------------------------------------------------- raw PTY

    def record_raw(self, data: str) -> None:
        if not data:
            return
        encoded = data.encode("utf-8", errors="replace")
        with self._lock:
            if self._raw_fp is not None:
                self._raw_fp.write(encoded)
                self._raw_fp.flush()
            self.ring.append(data)

    # --------------------------------------------------------------- screen

    def record_screen(self, screen: str, cursor: Optional[tuple[int, int]] = None) -> None:
        entry = {
            "timestamp": time.time(),
            "cursor": list(cursor) if cursor else None,
            "screen": screen,
        }
        with self._lock:
            _append_jsonl(self.screen_path, entry)
            self.screen_ring.append(entry)

    # --------------------------------------------------------------- audit

    def record_decision(self, decision: dict, raw_request: Optional[dict] = None) -> None:
        entry = {
            "timestamp": time.time(),
            "kind": "decision",
            "decision": decision,
        }
        with self._lock:
            _append_jsonl(self.audit_path, entry)
            self.audit_ring.append(entry)
            # Also persist the raw controller I/O separately.
            if raw_request is not None:
                _append_jsonl(self.controller_path, {
                    "timestamp": time.time(),
                    "request": raw_request,
                    "response": decision,
                })

    def record_action(self, action: str, text: Optional[str] = None,
                      key: Optional[str] = None, source: str = "controller") -> None:
        entry = {
            "timestamp": time.time(),
            "kind": "action",
            "action": action,
            "text": text,
            "key": key,
            "source": source,  # "controller" | "manual" | "feedback"
        }
        with self._lock:
            _append_jsonl(self.audit_path, entry)
            self.audit_ring.append(entry)

    # --------------------------------------------------------------- feedback

    def record_feedback(self, mode: str, message: str) -> None:
        with self._lock:
            _append_jsonl(self.feedback_path, {
                "timestamp": time.time(),
                "mode": mode,
                "message": message,
            })

    # --------------------------------------------------------------- summary

    def write_summary(self, summary: dict) -> None:
        with self._lock:
            with self.summary_path.open("w", encoding="utf-8") as f:
                json.dump(summary, f, ensure_ascii=False, indent=2, default=str)

    # --------------------------------------------------------------- readers

    def read_raw(self, tail_bytes: Optional[int] = None) -> str:
        with self._lock:
            if self._raw_fp is not None:
                self._raw_fp.flush()
        if not self.raw_path.exists():
            return ""
        if tail_bytes is None:
            return self.raw_path.read_text(encoding="utf-8", errors="replace")
        size = self.raw_path.stat().st_size
        with self.raw_path.open("rb") as f:
            f.seek(max(0, size - tail_bytes))
            return f.read().decode("utf-8", errors="replace")

    def read_jsonl(self, path: Path, tail: Optional[int] = None) -> list[dict]:
        return _read_jsonl(path, tail)


class Recorder:
    """Owns the on-disk log tree and the per-agent recorders.

    One Recorder per process. Thread-safe. Session directories are created
    lazily on `register_session`.
    """

    def __init__(self, log_dir: Optional[Path] = None) -> None:
        self.log_dir = log_dir or settings.log_dir
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, Path] = {}
        self._agents: dict[tuple[str, str], _AgentRecorder] = {}
        self._lock = threading.Lock()

    # --------------------------------------------------------------- sessions

    def register_session(self, session_id: str, manifest: dict) -> Path:
        """Create the session directory and write its manifest."""
        with self._lock:
            sdir = self.log_dir / session_id
            sdir.mkdir(parents=True, exist_ok=True)
            (sdir / "agents").mkdir(exist_ok=True)
            self._sessions[session_id] = sdir
        manifest_path = sdir / "manifest.json"
        with manifest_path.open("w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2, default=str)
        return sdir

    def update_manifest(self, session_id: str, updates: dict) -> None:
        """Atomically merge runtime state into a recorded session manifest."""
        sdir = self.session_dir(session_id)
        if sdir is None:
            return
        path = sdir / "manifest.json"
        pending = sdir / ".manifest.json.pending"
        with self._lock:
            current: dict = {}
            if path.exists():
                try:
                    current = json.loads(path.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    current = {}
            current.update(updates)
            pending.write_text(
                json.dumps(current, ensure_ascii=False, indent=2, default=str),
                encoding="utf-8",
            )
            pending.replace(path)

    def session_dir(self, session_id: str) -> Optional[Path]:
        return self._sessions.get(session_id) or (
            (self.log_dir / session_id) if (self.log_dir / session_id).exists() else None
        )

    # --------------------------------------------------------------- agents

    def register_agent(self, session_id: str, agent_id: str, role: str) -> _AgentRecorder:
        """Open a new, separately recorded invocation for an agent.

        Revisions, retries, reviewer gates, and resumes each get their own numbered
        directory under agents/<agent_id>/sessions/ instead of being mixed.
        """
        sdir = self.session_dir(session_id)
        if sdir is None:
            sdir = self.register_session(session_id, {"session_id": session_id})
        agent_dir = sdir / "agents" / agent_id
        sessions_dir = agent_dir / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        existing = [p for p in sessions_dir.iterdir() if p.is_dir() and p.name.isdigit()]
        attempt_id = f"{max((int(p.name) for p in existing), default=0) + 1:04d}"
        adir = sessions_dir / attempt_id
        previous = self.get_agent(session_id, agent_id)
        if previous is not None:
            previous.close()
        rec = _AgentRecorder(
            agent_id=agent_id,
            attempt_id=attempt_id,
            dir=adir,
            raw_path=adir / "raw.pty.log",
            screen_path=adir / "screen_snapshots.jsonl",
            audit_path=adir / "audit.jsonl",
            controller_path=adir / "controller.jsonl",
            feedback_path=adir / "feedback.jsonl",
            summary_path=adir / "summary.json",
        )
        rec.open()
        _append_jsonl(agent_dir / "sessions.jsonl", {
            "attempt_id": attempt_id,
            "role": role,
            "started_at": time.time(),
            "path": str(adir),
        })
        with self._lock:
            self._agents[(session_id, agent_id)] = rec
        return rec

    def get_agent(self, session_id: str, agent_id: str) -> Optional[_AgentRecorder]:
        return self._agents.get((session_id, agent_id))

    def latest_agent_dir(self, session_id: str, agent_id: str) -> Optional[Path]:
        active = self.get_agent(session_id, agent_id)
        if active is not None:
            return active.dir
        sdir = self.session_dir(session_id)
        if sdir is None:
            return None
        sessions_dir = sdir / "agents" / agent_id / "sessions"
        attempts = sorted(p for p in sessions_dir.iterdir() if p.is_dir()) if sessions_dir.exists() else []
        return attempts[-1] if attempts else None

    def close_agent(self, session_id: str, agent_id: str) -> None:
        with self._lock:
            rec = self._agents.pop((session_id, agent_id), None)
        if rec:
            rec.close()

    def close_all(self) -> None:
        with self._lock:
            recs = list(self._agents.values())
            self._agents.clear()
        for rec in recs:
            rec.close()

    # --------------------------------------------------------------- session-level files

    def record_event(self, session_id: str, event: dict) -> None:
        sdir = self.session_dir(session_id)
        if sdir is None:
            return
        with self._lock:
            _append_jsonl(sdir / "events.jsonl", event)

    def record_handoff(self, session_id: str, handoff: dict) -> None:
        sdir = self.session_dir(session_id)
        if sdir is None:
            return
        with self._lock:
            _append_jsonl(sdir / "handoffs.jsonl", handoff)

    # --------------------------------------------------------------- readers

    def read_events(self, session_id: str, tail: Optional[int] = None) -> list[dict]:
        sdir = self.session_dir(session_id)
        if sdir is None:
            return []
        return _read_jsonl(sdir / "events.jsonl", tail)

    def read_handoffs(self, session_id: str) -> list[dict]:
        sdir = self.session_dir(session_id)
        if sdir is None:
            return []
        path = sdir / "handoffs.jsonl"
        if not path.exists():
            return []
        out = []
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return out

    def list_sessions(self) -> list[dict]:
        """List every recorded session on disk with its manifest."""
        out = []
        if not self.log_dir.exists():
            return out
        for child in sorted(self.log_dir.iterdir()):
            if not child.is_dir():
                continue
            manifest_path = child / "manifest.json"
            manifest = {}
            if manifest_path.exists():
                try:
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    pass
            agents_dir = child / "agents"
            agents = sorted(d.name for d in agents_dir.iterdir()) if agents_dir.exists() else []
            out.append({
                "session_id": child.name,
                "manifest": manifest,
                "agents": agents,
                "path": str(child),
            })
        return out

    def list_agent_files(self, session_id: str, agent_id: str) -> dict:
        """Return every per-invocation recording, project-relative and sized."""
        sdir = self.session_dir(session_id)
        if sdir is None:
            return {}
        adir = sdir / "agents" / agent_id
        if not adir.exists():
            return {}
        files = {}
        for p in sorted(adir.rglob("*")):
            if p.is_file():
                rel = str(p.relative_to(adir))
                files[rel] = {"path": str(p), "size_bytes": p.stat().st_size}
        return files

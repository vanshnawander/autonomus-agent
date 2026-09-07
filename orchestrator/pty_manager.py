"""PTY Session Manager.

Each agent runs as a `devin` CLI process inside a real pseudo-terminal (via
pexpect). This module owns the low-level terminal manipulation:

    start / stop / restart / resume
    send_text / send_line / send_enter / send_ctrl_c / send_escape
    resize / read_available / capture_visible_screen

It deliberately does NOT make decisions — it is dumb I/O. The control loop and
LLM controller sit on top of it.
"""
from __future__ import annotations

import os
import re
import shlex
import time
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Optional

import pexpect

from .config import settings
from .terminal_screen import TerminalScreen


@dataclass
class PTYSession:
    """A single agent's PTY + terminal emulator."""

    agent_id: str
    command: str
    cwd: Optional[str] = None
    cols: int = field(default_factory=lambda: settings.terminal_cols)
    rows: int = field(default_factory=lambda: settings.terminal_rows)
    child: Optional[pexpect.spawn] = field(default=None, repr=False)
    screen: TerminalScreen = field(init=False, repr=False)
    last_output_at: float = field(default_factory=time.time)
    started_at: Optional[float] = field(default=None)
    # Devin session id, harvested from the terminal once Devin prints it.
    devin_session_id: Optional[str] = None
    _lock: Lock = field(default_factory=Lock, repr=False)
    # Raw byte log for debugging / replay.
    raw_log: list[str] = field(default_factory=list, repr=False)

    def __post_init__(self) -> None:
        self.screen = TerminalScreen(self.cols, self.rows)

    # ------------------------------------------------------------------ lifecycle

    def start(self, extra_args: Optional[list[str]] = None) -> None:
        """Spawn the agent command inside a PTY."""
        with self._lock:
            if self.child is not None and self.child.isalive():
                raise RuntimeError(f"Agent {self.agent_id} already running")
            cmd = self.command
            if extra_args:
                cmd = cmd + " " + " ".join(shlex.quote(a) for a in extra_args)
            child_env = os.environ.copy()
            # Windsurf injects ACP_BACKEND for its embedded host. A standalone
            # `devin` child mis-detects ACP mode when this leaks into its env and
            # refuses to use normal CLI credentials.
            child_env.pop("ACP_BACKEND", None)
            self.child = pexpect.spawn(
                cmd,
                cwd=self.cwd,
                env=child_env,
                encoding="utf-8",
                codec_errors="replace",
                echo=False,
                dimensions=(self.rows, self.cols),
                timeout=None,
            )
            self.started_at = time.time()
            self.last_output_at = time.time()
            self.raw_log.clear()
            self.screen = TerminalScreen(self.cols, self.rows)

    def stop(self, force: bool = True) -> None:
        """Terminate the agent process."""
        with self._lock:
            child = self.child
            self.child = None
        if child is None:
            return
        try:
            if child.isalive():
                child.sendcontrol("c")
                time.sleep(0.2)
                if force and child.isalive():
                    child.close(force=True)
        except Exception:
            pass

    def is_alive(self) -> bool:
        with self._lock:
            return self.child is not None and self.child.isalive()

    def pause(self) -> None:
        with self._lock:
            child = self.child
        if child is None or not child.isalive():
            raise RuntimeError(f"Agent {self.agent_id} is not running")
        os.killpg(os.getpgid(child.pid), 19)  # SIGSTOP

    def resume(self) -> None:
        with self._lock:
            child = self.child
        if child is None or not child.isalive():
            raise RuntimeError(f"Agent {self.agent_id} is not running")
        os.killpg(os.getpgid(child.pid), 18)  # SIGCONT

    # ------------------------------------------------------------------ input

    def send_text(self, text: str) -> None:
        with self._lock:
            if self.child:
                self.child.send(text)

    def send_line(self, text: str) -> None:
        with self._lock:
            if self.child:
                self.child.sendline(text)

    def send_enter(self) -> None:
        with self._lock:
            if self.child:
                self.child.send("\r")

    def send_ctrl_c(self) -> None:
        with self._lock:
            if self.child:
                self.child.sendcontrol("c")

    def send_escape(self) -> None:
        with self._lock:
            if self.child:
                self.child.send("\x1b")

    def press_key(self, key: str) -> None:
        """Send a named key. Supports a small common set."""
        mapping = {
            "enter": "\r",
            "return": "\r",
            "esc": "\x1b",
            "escape": "\x1b",
            "tab": "\t",
            "backspace": "\x7f",
            "up": "\x1b[A",
            "down": "\x1b[B",
            "right": "\x1b[C",
            "left": "\x1b[D",
            "space": " ",
            "y": "y",
            "n": "n",
        }
        seq = mapping.get(key.lower(), key)
        with self._lock:
            if self.child:
                # send raw Enter for TUI controls; other keys use their sequence.
                if key.lower() in ("enter", "return"):
                    self.child.send("\r")
                else:
                    self.child.send(seq)

    def resize(self, cols: int, rows: int) -> None:
        with self._lock:
            if self.child:
                self.child.setwinsize(rows, cols)
            self.cols, self.rows = cols, rows
            self.screen.resize(cols, rows)

    # ------------------------------------------------------------------ output

    def read_available(self, max_chunks: int = 64) -> str:
        """Drain whatever output is currently available from the PTY.

        Feeds it into the terminal screen and returns the raw string.
        Non-blocking: returns "" if nothing is available.
        """
        with self._lock:
            child = self.child
        if child is None:
            return ""
        chunks: list[str] = []
        for _ in range(max_chunks):
            try:
                data = child.read_nonblocking(size=4096, timeout=0.05)
                if data:
                    chunks.append(data)
                    self.last_output_at = time.time()
            except pexpect.TIMEOUT:
                break
            except pexpect.EOF:
                break
            except OSError:
                break
        out = "".join(chunks)
        if out:
            with self._lock:
                self.raw_log.append(out)
            self.screen.feed(out)
            self._maybe_capture_devin_session_id(out)
        return out

    def capture_visible_screen(self) -> str:
        return self.screen.visible()

    def recent_output(self, n: int = 20) -> str:
        return self.screen.recent_output(n)

    def cursor_position(self) -> tuple[int, int]:
        return self.screen.cursor_position()

    # ------------------------------------------------------------------ helpers

    def _maybe_capture_devin_session_id(self, out: str) -> None:
        """Devin prints a session id early on; try to grab it once."""
        if self.devin_session_id:
            return
        # Accept only an explicit Devin/session-id marker. Bare `Session:`
        # also appears for nested shell tools and is not a resumable Devin ID.
        marker = re.compile(
            r"^\s*(?:devin\s+session(?:\s+id)?|session\s+id)\s*:\s*"
            r"([A-Za-z0-9][A-Za-z0-9_-]*)\s*$",
            re.IGNORECASE,
        )
        for line in out.splitlines():
            match = marker.match(line)
            if match:
                self.devin_session_id = match.group(1)
                return

    def is_quiet(self, quiet_ms: Optional[int] = None) -> bool:
        q = quiet_ms if quiet_ms is not None else settings.quiet_ms
        return (time.time() - self.last_output_at) * 1000 > q


class PTYManager:
    """Owns all PTY sessions for a pipeline run."""

    def __init__(self) -> None:
        self._sessions: dict[tuple[str, str], PTYSession] = {}
        self._lock = Lock()

    @staticmethod
    def _key(agent_id: str, project_id: Optional[str] = None) -> tuple[str, str]:
        return (project_id or "__default__", agent_id)

    # ------------------------------------------------------------------ factory

    @staticmethod
    def build_command(
        role_system_prompt: str,
        resume_session_id: Optional[str] = None,
        export_path: Optional[str] = None,
        permission_mode: Optional[str] = None,
        model: Optional[str] = None,
    ) -> str:
        """Construct the `devin` invocation for a role.

        Fresh start:  devin [extra args] [--export <dir>] -- "<full prompt>"
        Resume:       devin -r <id> [extra args] [--export <dir>] -- "<full prompt>"

        ``role_system_prompt`` should be the FULLY COMPOSED prompt (base + role +
        any extra runtime instruction). Use ``Role.full_prompt(extra_prompt)`` or
        ``prompts.build_agent_prompt(role_key, extra_prompt)`` to produce it.

        DEVIN_ORCH_DEVIN_EXTRA_ARGS contains only transport flags; the session approval mode selects Devin permissions so
        commands and edits remain visible in the PTY. The controller terminates a
        role after its validated stage marker, so interactive mode does not leave
        completed sessions running indefinitely.

        When settings.devin_export_traces is True and export_path is given, we
        append `--export <file>` so the full conversation transcript lands next
        to the orchestrator's own PTY/screen/audit recordings.
        """
        parts = [settings.devin_command]
        if resume_session_id:
            parts += ["-r", resume_session_id]
        selected_model = model or settings.devin_model
        if selected_model:
            parts += ["--model", selected_model]
        extra = shlex.split(settings.devin_extra_args.strip())
        # The orchestration mode owns Devin approval behavior. Strip legacy
        # permission and print flags so environment settings cannot bypass the controller.
        cleaned_extra: list[str] = []
        skip_next = False
        for arg in extra:
            if skip_next:
                skip_next = False
                continue
            if arg == "--permission-mode":
                skip_next = True
                continue
            if arg.startswith("--permission-mode=") or arg in {"-p", "--print"}:
                continue
            cleaned_extra.append(arg)
        parts += ["--permission-mode", permission_mode or "auto"]
        parts += cleaned_extra
        if settings.devin_export_traces and export_path:
            Path(export_path).parent.mkdir(parents=True, exist_ok=True)
            parts += ["--export", export_path]
        parts += ["--", role_system_prompt]
        return " ".join(shlex.quote(p) if " " in p or any(c in p for c in '"\'') else p for p in parts)

    # ------------------------------------------------------------------ registry

    def create(
        self,
        agent_id: str,
        command: str,
        cwd: Optional[str] = None,
        cols: Optional[int] = None,
        rows: Optional[int] = None,
        project_id: Optional[str] = None,
    ) -> PTYSession:
        key = self._key(agent_id, project_id)
        with self._lock:
            if key in self._sessions and self._sessions[key].is_alive():
                raise RuntimeError(f"Agent {agent_id} already exists in project {project_id or '__default__'}")
            sess = PTYSession(
                agent_id=agent_id,
                command=command,
                cwd=cwd,
                cols=cols or settings.terminal_cols,
                rows=rows or settings.terminal_rows,
            )
            self._sessions[key] = sess
            return sess

    def get(self, agent_id: str, project_id: Optional[str] = None) -> Optional[PTYSession]:
        exact = self._sessions.get(self._key(agent_id, project_id))
        if exact is not None or project_id is not None:
            return exact
        matches = [sess for (_project, aid), sess in self._sessions.items() if aid == agent_id]
        return matches[0] if len(matches) == 1 else None

    def all(self, project_id: Optional[str] = None) -> dict[tuple[str, str], PTYSession]:
        if project_id is None:
            return dict(self._sessions)
        return {key: sess for key, sess in self._sessions.items() if key[0] == project_id}

    def remove(self, agent_id: str, force: bool = True, project_id: Optional[str] = None) -> None:
        key = self._key(agent_id, project_id)
        if project_id is None and key not in self._sessions:
            matches = [candidate for candidate in self._sessions if candidate[1] == agent_id]
            if len(matches) == 1:
                key = matches[0]
        sess = self._sessions.pop(key, None)
        if sess:
            sess.stop(force=force)

    def stop_all(self, project_id: Optional[str] = None) -> None:
        for project, agent_id in list(self._sessions):
            if project_id is None or project == project_id:
                self.remove(agent_id, project_id=project)

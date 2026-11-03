"""CLI-agent adapter contract.

An adapter teaches the orchestrator how to drive one terminal coding agent
(Devin, OpenCode, Codex, Claude Code, ...) inside a PTY. The control loop stays
CLI-agnostic and asks the adapter for everything that differs between tools:

    build_argv        how to launch a fresh or resumed session with a prompt
    prepare_env       environment cleanup / per-CLI configuration
    startup_action    deterministic answers to first-run dialogs (folder trust,
                      update prompts) that must never be left to the LLM
    menu_state        detection of the CLI's tool-approval menu
    busy              CLI-specific "still working" indicators for idle detection
    session ids       capture / discovery of a resumable CLI session id
    export_trace      best-effort copy of the CLI's own transcript

Adapters do no I/O against the PTY themselves; they only inspect rendered
screen text and return keys for the control loop to send and audit.
"""
from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class LaunchContext:
    """Everything an adapter needs to build a launch command."""

    prompt: str
    cwd: Optional[str] = None
    approval_mode: str = "manual"
    model: Optional[str] = None
    resume_session_id: Optional[str] = None
    export_path: Optional[str] = None
    # Session id chosen by the orchestrator before launch (CLIs that accept one).
    new_session_id: Optional[str] = None
    # Explicit permission-mode override (Devin legacy API).
    permission_mode: Optional[str] = None


@dataclass(frozen=True)
class MenuState:
    """A tool-approval menu visible on screen."""

    active: bool = False
    # True when the highlighted option is the one-time approval.
    approve_selected: bool = False
    # Last lines of the menu, shown to humans approving it.
    excerpt: str = ""


@dataclass(frozen=True)
class StartupAction:
    """Keys that answer a known first-run dialog."""

    description: str
    keys: tuple[str, ...]


@dataclass(frozen=True)
class Capabilities:
    resume: bool = False
    trace_export: bool = False
    session_id_capture: bool = False
    model_selection: bool = True


_INACTIVE = MenuState()


def screen_lines(screen: str) -> list[str]:
    return [line.rstrip() for line in screen.splitlines() if line.strip()]


def tail_excerpt(screen: str, n: int = 12) -> str:
    return "\n".join(screen_lines(screen)[-n:])


class AgentAdapter:
    """Base adapter. Subclasses override the class attributes and hooks."""

    name: str = ""
    display_name: str = ""
    description: str = ""
    default_command: str = ""
    model_hint: str = ""
    notes: str = ""
    capabilities: Capabilities = Capabilities()
    # Strings that mean the CLI is actively working (checked case-insensitively
    # against the last lines of the screen).
    busy_markers: tuple[str, ...] = ()
    # Env vars removed from the child environment.
    strip_env: tuple[str, ...] = ()
    strip_env_prefixes: tuple[str, ...] = ()
    # CLI-specific guidance appended to the controller's view of this terminal.
    controller_guidance: str = ""

    # ------------------------------------------------------------------ config

    @property
    def env_prefix(self) -> str:
        return "DEVIN_ORCH_" + re.sub(r"[^A-Z0-9]", "_", self.name.upper())

    def command(self) -> str:
        return os.environ.get(f"{self.env_prefix}_COMMAND", self.default_command)

    def default_model(self) -> Optional[str]:
        return os.environ.get(f"{self.env_prefix}_MODEL") or None

    def extra_args(self) -> list[str]:
        return shlex.split(os.environ.get(f"{self.env_prefix}_EXTRA_ARGS", ""))

    def is_installed(self) -> bool:
        parts = shlex.split(self.command())
        return bool(parts) and shutil.which(parts[0]) is not None

    def info(self) -> dict:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "description": self.description,
            "installed": self.is_installed(),
            "command": self.command(),
            "default_model": self.default_model(),
            "model_hint": self.model_hint,
            "capabilities": {
                "resume": self.capabilities.resume,
                "trace_export": self.capabilities.trace_export,
                "session_id_capture": self.capabilities.session_id_capture,
                "model_selection": self.capabilities.model_selection,
            },
            "notes": self.notes,
        }

    # ------------------------------------------------------------------ launch

    def build_argv(self, ctx: LaunchContext) -> list[str]:
        raise NotImplementedError

    def prepare_env(self, env: dict[str, str], ctx: LaunchContext) -> dict[str, str]:
        for key in self.strip_env:
            env.pop(key, None)
        for key in list(env):
            if any(key.startswith(prefix) for prefix in self.strip_env_prefixes):
                env.pop(key, None)
        return env

    def new_session_id(self) -> Optional[str]:
        """Return an id to assign at launch, for CLIs that accept one."""
        return None

    # ------------------------------------------------------------------ screen

    def startup_action(self, screen: str, trusted_workspace: bool) -> Optional[StartupAction]:
        """Answer a known first-run dialog, or return None."""
        return None

    def menu_state(self, screen: str) -> MenuState:
        return _INACTIVE

    def busy(self, screen: str) -> bool:
        if not self.busy_markers:
            return False
        tail = "\n".join(screen_lines(screen)[-6:]).lower()
        return any(marker in tail for marker in self.busy_markers)

    # ------------------------------------------------------------------ sessions

    def extract_session_id(self, text: str) -> Optional[str]:
        return None

    def discover_session_id(self, cwd: Optional[str], started_at: Optional[float]) -> Optional[str]:
        """Find the id of a session started in ``cwd`` at/after ``started_at``."""
        return None

    def export_trace(self, session_id: str, cwd: Optional[str], dest: Path) -> Optional[Path]:
        """Copy the CLI's transcript for ``session_id`` to ``dest``."""
        return None

    # ------------------------------------------------------------------ helpers

    @staticmethod
    def _run_json(argv: list[str], cwd: Optional[str], timeout: float = 10.0):
        import json

        try:
            proc = subprocess.run(
                argv, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if proc.returncode != 0:
            return None
        try:
            return json.loads(proc.stdout)
        except ValueError:
            return None


__all__ = [
    "AgentAdapter",
    "Capabilities",
    "LaunchContext",
    "MenuState",
    "StartupAction",
    "screen_lines",
    "tail_excerpt",
]

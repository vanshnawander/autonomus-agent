"""Devin CLI adapter (reference implementation)."""
from __future__ import annotations

import json
import re
import shlex
from pathlib import Path
from typing import Optional

from ..config import settings
from .base import AgentAdapter, Capabilities, LaunchContext, MenuState, tail_excerpt

# Accept only an explicit Devin/session-id marker. Bare `Session:` also appears
# for nested shell tools and is not a resumable Devin ID.
_SESSION_MARKER = re.compile(
    r"^\s*(?:devin\s+session(?:\s+id)?|session\s+id)\s*:\s*"
    r"([A-Za-z0-9][A-Za-z0-9_-]*)\s*$",
    re.IGNORECASE,
)
_APPROVE_ONCE_SELECTED = re.compile(r"(?m)^\s*❭\s*1\s+Yes\s+\(Approve once\)")


class DevinAdapter(AgentAdapter):
    name = "devin"
    display_name = "Devin CLI"
    description = "Cognition's Devin terminal agent. Reference integration with trace export and resume."
    model_hint = "Devin model name, e.g. swe-2-high or glm-5.2"
    notes = "Permission mode: manual → auto, autonomous → smart. Traces exported with --export."
    capabilities = Capabilities(resume=True, trace_export=True, session_id_capture=True)
    # Windsurf injects ACP_BACKEND for its embedded host. A standalone `devin`
    # child mis-detects ACP mode when this leaks into its env and refuses to
    # use normal CLI credentials.
    strip_env = ("ACP_BACKEND",)
    controller_guidance = (
        "Devin CLI: the input composer line starts with `❭`. If it visibly holds a complete unsent "
        "instruction while idle, press_enter once. Tool confirmations show `1 Yes (Approve once)` with "
        "`select`/`confirm` hints; press_enter approves the highlighted option, Escape rejects."
    )

    # Devin keeps its historical settings names (DEVIN_ORCH_DEVIN_*).
    def command(self) -> str:
        return settings.devin_command

    def default_model(self) -> Optional[str]:
        return settings.devin_model or None

    def extra_args(self) -> list[str]:
        return shlex.split(settings.devin_extra_args.strip())

    def build_argv(self, ctx: LaunchContext) -> list[str]:
        """Fresh:  devin [--model m] --permission-mode p [extra] [--export f] -- <prompt>
        Resume: devin -r <id> ... -- <prompt>

        The session approval mode selects Devin permissions so commands and
        edits remain visible in the PTY. Legacy permission and print flags are
        stripped from extra args so environment settings cannot bypass the
        controller.
        """
        argv = shlex.split(self.command())
        if ctx.resume_session_id:
            argv += ["-r", ctx.resume_session_id]
        model = ctx.model or self.default_model()
        if model:
            argv += ["--model", model]
        cleaned: list[str] = []
        skip_next = False
        for arg in self.extra_args():
            if skip_next:
                skip_next = False
                continue
            if arg == "--permission-mode":
                skip_next = True
                continue
            if arg.startswith("--permission-mode=") or arg in {"-p", "--print"}:
                continue
            cleaned.append(arg)
        mode = ctx.permission_mode or ("smart" if ctx.approval_mode == "autonomous" else "auto")
        argv += ["--permission-mode", mode]
        argv += cleaned
        if settings.devin_export_traces and ctx.export_path:
            Path(ctx.export_path).parent.mkdir(parents=True, exist_ok=True)
            argv += ["--export", ctx.export_path]
        argv += ["--", ctx.prompt]
        return argv

    def menu_state(self, screen: str) -> MenuState:
        if not ("Approve once" in screen and "select" in screen and "confirm" in screen):
            return MenuState()
        return MenuState(
            active=True,
            approve_selected=_APPROVE_ONCE_SELECTED.search(screen) is not None,
            excerpt=tail_excerpt(screen),
        )

    def extract_session_id(self, text: str) -> Optional[str]:
        for line in text.splitlines():
            match = _SESSION_MARKER.match(line)
            if match:
                return match.group(1)
        return None

    @staticmethod
    def session_id_from_trace(path: Path) -> Optional[str]:
        try:
            value = json.loads(path.read_text(encoding="utf-8")).get("session_id")
        except (OSError, json.JSONDecodeError, AttributeError):
            return None
        if isinstance(value, str) and value and all(c.isalnum() or c in "-_" for c in value):
            return value
        return None

"""Claude Code adapter."""
from __future__ import annotations

import os
import re
import shlex
import shutil
import uuid
from pathlib import Path
from typing import Optional

from .base import AgentAdapter, Capabilities, LaunchContext, MenuState, StartupAction, tail_excerpt

_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
_RESUME_HINT = re.compile(rf"claude\s+(?:--resume|-r)\s+({_UUID})")
# Tool permission prompt: "Do you want to proceed?" / "Do you want to make this
# edit to x?" followed by numbered options ending in "No, and tell Claude ...".
_MENU_QUESTION = re.compile(r"Do you want to (?:proceed|make this edit|create|run|allow|fetch)", re.IGNORECASE)
_MENU_OPTION_YES = re.compile(r"(?m)^\s*(?:❯\s*)?1\.\s+Yes\b")
_MENU_YES_SELECTED = re.compile(r"(?m)^\s*❯\s*1\.\s+Yes\b")
_TRUST_YES_SELECTED = re.compile(r"(?m)^\s*❯\s*Yes, I trust this folder")


class ClaudeCodeAdapter(AgentAdapter):
    name = "claude-code"
    display_name = "Claude Code"
    description = "Anthropic's Claude Code CLI. Session id is assigned at launch, so resume is deterministic."
    default_command = "claude"
    model_hint = "Model alias or id, e.g. opus, sonnet, claude-opus-5-5"
    notes = (
        "Permission mode acceptEdits (override with DEVIN_ORCH_CLAUDE_CODE_PERMISSION_MODE); shell "
        "commands surface as approval menus for the controller and safety gate. The folder-trust "
        "dialog is accepted automatically only for workspaces under DEVIN_ORCH_WORKSPACE_ROOT."
    )
    capabilities = Capabilities(resume=True, trace_export=True, session_id_capture=True)
    busy_markers = ("esc to interrupt",)
    # Markers inherited when the orchestrator itself runs under Claude Code make
    # the child think it is a nested session (e.g. transcript saving disabled).
    strip_env = (
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_SESSION_ATTENDED",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_CODE_SSE_PORT",
        "CLAUDE_PID",
    )
    controller_guidance = (
        "Claude Code: the composer is the line starting with `❯` between two horizontal rules. "
        "While working, the footer shows `esc to interrupt` — wait. Tool permission prompts read "
        "`Do you want to proceed?` with `❯ 1. Yes`, `2. Yes, and don't ask again ...`, and "
        "`3. No, and tell Claude what to do differently (esc)`. press_enter approves the highlighted "
        "option once; send_escape rejects. Never choose a 'don't ask again' option."
    )

    def permission_mode(self) -> str:
        return os.environ.get(f"{self.env_prefix}_PERMISSION_MODE", "acceptEdits")

    def new_session_id(self) -> Optional[str]:
        return str(uuid.uuid4())

    def build_argv(self, ctx: LaunchContext) -> list[str]:
        argv = shlex.split(self.command())
        if ctx.resume_session_id:
            argv += ["--resume", ctx.resume_session_id]
        elif ctx.new_session_id:
            argv += ["--session-id", ctx.new_session_id]
        model = ctx.model or self.default_model()
        if model:
            argv += ["--model", model]
        argv += ["--permission-mode", ctx.permission_mode or self.permission_mode()]
        argv += [arg for arg in self.extra_args() if arg not in _FORBIDDEN_ARGS]
        argv += ["--", ctx.prompt]
        return argv

    def startup_action(self, screen: str, trusted_workspace: bool) -> Optional[StartupAction]:
        if "Yes, I trust this folder" not in screen or not trusted_workspace:
            return None
        if _TRUST_YES_SELECTED.search(screen):
            return StartupAction("accept folder trust for the orchestrator workspace", ("\r",))
        # The default selection is "No, exit"; move down first and confirm on
        # the next observation once "Yes" is visibly selected.
        return StartupAction("select 'Yes, I trust this folder'", ("\x1b[B",))

    def menu_state(self, screen: str) -> MenuState:
        if not (_MENU_QUESTION.search(screen) and _MENU_OPTION_YES.search(screen)):
            return MenuState()
        return MenuState(
            active=True,
            approve_selected=_MENU_YES_SELECTED.search(screen) is not None,
            excerpt=tail_excerpt(screen),
        )

    def extract_session_id(self, text: str) -> Optional[str]:
        match = _RESUME_HINT.search(text)
        return match.group(1) if match else None

    def export_trace(self, session_id: str, cwd: Optional[str], dest: Path) -> Optional[Path]:
        base = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / "projects"
        matches = sorted(base.glob(f"*/{session_id}.jsonl"), key=lambda p: p.stat().st_mtime)
        if not matches:
            return None
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(matches[-1], dest)
        return dest


# Flags that would let environment config bypass the controller's approvals.
_FORBIDDEN_ARGS = {
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "-p",
    "--print",
}

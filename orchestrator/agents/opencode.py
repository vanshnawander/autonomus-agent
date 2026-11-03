"""OpenCode adapter."""
from __future__ import annotations

import json
import os
import shlex
import subprocess
from pathlib import Path
from typing import Optional

from .base import AgentAdapter, Capabilities, LaunchContext, MenuState, tail_excerpt

# Read-only shell commands OpenCode may run without a confirmation menu. Every
# other command asks, so the controller and SafetyGate see it.
_READONLY_BASH = (
    "ls", "ls *", "pwd", "cat *", "head *", "tail *", "wc *", "grep *", "rg *", "find *",
    "git status*", "git diff*", "git log*", "git show*", "which *", "echo *",
)


def permission_config() -> dict:
    bash: dict[str, str] = {"*": "ask"}
    bash.update({pattern: "allow" for pattern in _READONLY_BASH})
    return {
        "permission": {
            "edit": "allow",
            "bash": bash,
            "webfetch": "allow",
            "external_directory": "ask",
        }
    }


class OpenCodeAdapter(AgentAdapter):
    name = "opencode"
    display_name = "OpenCode"
    description = "sst/opencode terminal agent; works with any provider configured in OpenCode."
    default_command = "opencode"
    model_hint = "provider/model, e.g. anthropic/claude-sonnet-4-5 or openrouter/z-ai/glm-4.6"
    notes = (
        "Permissions injected through OPENCODE_CONFIG_CONTENT: edits allowed, read-only shell "
        "commands allowed, every other shell command asks. Set your own OPENCODE_CONFIG_CONTENT "
        "to override. Session ids are discovered with `opencode session list`."
    )
    capabilities = Capabilities(resume=True, trace_export=True, session_id_capture=True)
    busy_markers = ("esc interrupt", "esc to interrupt")
    controller_guidance = (
        "OpenCode: full-screen TUI; the composer is the bordered box (┃) above the model/agent line. "
        "While a response streams the footer shows `esc interrupt` — wait. If the composer holds a "
        "complete unsent instruction while idle, press_enter once. Permission prompts show "
        "`Permission required` with `Allow once`, `Allow always`, `Reject`; press_enter accepts the "
        "highlighted `Allow once`, send_escape rejects. Never choose `Allow always`."
    )

    def build_argv(self, ctx: LaunchContext) -> list[str]:
        argv = shlex.split(self.command())
        if ctx.resume_session_id:
            argv += ["--session", ctx.resume_session_id]
        model = ctx.model or self.default_model()
        if model:
            argv += ["--model", model]
        argv += self.extra_args()
        argv += ["--prompt", ctx.prompt]
        return argv

    def prepare_env(self, env: dict[str, str], ctx: LaunchContext) -> dict[str, str]:
        env = super().prepare_env(env, ctx)
        env.setdefault("OPENCODE_CONFIG_CONTENT", json.dumps(permission_config()))
        return env

    def menu_state(self, screen: str) -> MenuState:
        if not ("Permission required" in screen and "Allow once" in screen):
            return MenuState()
        # The TUI marks the highlighted button with color only, which does not
        # survive screen rendering. "Allow once" is the default selection.
        return MenuState(active=True, approve_selected=True, excerpt=tail_excerpt(screen))

    def _sessions(self, cwd: Optional[str]) -> list[dict]:
        data = self._run_json(shlex.split(self.command()) + ["session", "list", "--format", "json"], cwd)
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []

    def discover_session_id(self, cwd: Optional[str], started_at: Optional[float]) -> Optional[str]:
        if started_at is None:
            return None
        threshold_ms = (started_at - 2) * 1000
        real_cwd = os.path.realpath(cwd) if cwd else None
        candidates = []
        for item in self._sessions(cwd):
            sid, created = item.get("id"), item.get("created")
            if not isinstance(sid, str) or not isinstance(created, (int, float)) or created < threshold_ms:
                continue
            directory = item.get("directory")
            if real_cwd and isinstance(directory, str) and os.path.realpath(directory) != real_cwd:
                continue
            candidates.append((created, sid))
        return max(candidates)[1] if candidates else None

    def export_trace(self, session_id: str, cwd: Optional[str], dest: Path) -> Optional[Path]:
        try:
            proc = subprocess.run(
                shlex.split(self.command()) + ["export", session_id],
                cwd=cwd, capture_output=True, text=True, timeout=30, check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if proc.returncode != 0 or not proc.stdout.strip():
            return None
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(proc.stdout, encoding="utf-8")
        return dest

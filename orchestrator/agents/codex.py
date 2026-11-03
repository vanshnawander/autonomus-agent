"""OpenAI Codex CLI adapter."""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import time
from pathlib import Path
from typing import Optional

from .base import AgentAdapter, Capabilities, LaunchContext, MenuState, StartupAction, tail_excerpt

_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
_RESUME_HINT = re.compile(rf"codex\s+resume\s+({_UUID})")
_MENU_QUESTION = re.compile(
    r"Would you like to (?:run the following command|make the following edits|grant|apply)",
    re.IGNORECASE,
)
_MENU_YES_SELECTED = re.compile(r"(?m)^\s*›\s*1\.\s+Yes\b")
_TRUST_SELECTED = re.compile(r"(?m)^\s*›\s*1\.\s+Trust and continue")


class CodexAdapter(AgentAdapter):
    name = "codex"
    display_name = "Codex CLI"
    description = "OpenAI's Codex CLI, sandboxed to the workspace with on-request approvals."
    default_command = "codex"
    model_hint = "Codex model id, e.g. gpt-5-codex"
    notes = (
        "Runs with --sandbox workspace-write (network enabled) and --ask-for-approval on-request; "
        "escalations surface as approval menus. Startup update prompts are always skipped."
    )
    capabilities = Capabilities(resume=True, trace_export=True, session_id_capture=True)
    busy_markers = ("esc to interrupt",)
    controller_guidance = (
        "Codex CLI: the composer line starts with `›` above a status footer. While working it shows "
        "`Working (… esc to interrupt)` — wait. Approval prompts read `Would you like to run the "
        "following command?` with `› 1. Yes, proceed`, a 'don't ask again' option, and `No, and tell "
        "Codex what to do differently (esc)`. press_enter approves the highlighted option once; "
        "send_escape rejects. Never choose a 'don't ask again' option."
    )

    def build_argv(self, ctx: LaunchContext) -> list[str]:
        argv = shlex.split(self.command())
        if ctx.resume_session_id:
            argv += ["resume", ctx.resume_session_id]
        argv += [
            "--no-alt-screen",
            "-c", "check_for_update_on_startup=false",
            "-c", "sandbox_workspace_write.network_access=true",
            "--sandbox", "workspace-write",
            "--ask-for-approval", "on-request",
        ]
        model = ctx.model or self.default_model()
        if model:
            argv += ["--model", model]
        if ctx.cwd:
            argv += ["--cd", ctx.cwd]
        argv += [arg for arg in self.extra_args() if arg not in _FORBIDDEN_ARGS]
        argv += ["--", ctx.prompt]
        return argv

    def startup_action(self, screen: str, trusted_workspace: bool) -> Optional[StartupAction]:
        # The update prompt's default option pipes an installer into sh. Skip it
        # unconditionally; it is never part of agent work.
        if "Update now" in screen and ("esc skip" in screen or "Skip" in screen):
            return StartupAction("skip Codex self-update prompt", ("\x1b",))
        if "Trust this folder?" in screen and trusted_workspace:
            if _TRUST_SELECTED.search(screen):
                return StartupAction("trust the orchestrator workspace", ("\r",))
            return StartupAction("select 'Trust and continue'", ("\x1b[A",))
        return None

    def menu_state(self, screen: str) -> MenuState:
        if not _MENU_QUESTION.search(screen):
            return MenuState()
        return MenuState(
            active=True,
            approve_selected=_MENU_YES_SELECTED.search(screen) is not None,
            excerpt=tail_excerpt(screen),
        )

    def extract_session_id(self, text: str) -> Optional[str]:
        match = _RESUME_HINT.search(text)
        return match.group(1) if match else None

    @staticmethod
    def _sessions_dir() -> Path:
        return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "sessions"

    def _rollouts(self, cwd: Optional[str], since: float) -> list[tuple[float, str, Path]]:
        found: list[tuple[float, str, Path]] = []
        root = self._sessions_dir()
        if not root.is_dir():
            return found
        # Rollouts are filed by local date; scanning the last two days covers
        # sessions that cross midnight.
        days = {time.strftime("%Y/%m/%d", time.localtime(t)) for t in (since, time.time())}
        for day in days:
            for path in (root / day).glob("rollout-*.jsonl"):
                try:
                    mtime = path.stat().st_mtime
                    if mtime < since:
                        continue
                    with path.open(encoding="utf-8") as fh:
                        meta = json.loads(fh.readline())
                except (OSError, ValueError):
                    continue
                payload = meta.get("payload", {}) if isinstance(meta, dict) else {}
                sid = payload.get("id")
                if not isinstance(sid, str):
                    continue
                if cwd and payload.get("cwd") and os.path.realpath(payload["cwd"]) != os.path.realpath(cwd):
                    continue
                found.append((mtime, sid, path))
        return sorted(found)

    def discover_session_id(self, cwd: Optional[str], started_at: Optional[float]) -> Optional[str]:
        if started_at is None:
            return None
        rollouts = self._rollouts(cwd, started_at - 2)
        return rollouts[-1][1] if rollouts else None

    def export_trace(self, session_id: str, cwd: Optional[str], dest: Path) -> Optional[Path]:
        root = self._sessions_dir()
        matches = sorted(root.glob(f"*/*/*/rollout-*{session_id}.jsonl")) if root.is_dir() else []
        if not matches:
            return None
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(matches[-1], dest)
        return dest


_FORBIDDEN_ARGS = {
    "--dangerously-bypass-approvals-and-sandbox",
    "--yolo",
    "--approve-for-me",
}

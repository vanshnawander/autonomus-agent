"""Idle / quiescence detector.

We can't rely on exact prompt matching (the CLI agents ask arbitrary questions,
print spinners, enter different modes, etc.). Instead we use a combination of
signals to decide when a terminal is probably waiting for input:

  - no new PTY output for `quiet_ms`
  - the visible screen has been stable across N samples
  - the process is still alive
  - the cursor looks like it's on an input line
  - the last visible text looks like a question or prompt

This is deliberately conservative: when in doubt, return False (keep waiting).
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from .pty_manager import PTYSession
from .config import settings


# Phrases that strongly suggest the terminal is asking for input.
_PROMPT_HINTS = (
    "(y/n)", "(y/N)", "[y/n]", "(yes/no)",
    "continue?", "proceed?", "approve?", "confirm?",
    "press enter", "press any key",
    "enter your", "please enter",
    "select an option", "choose:",
    "agent_question:", "agent_done",
    "approve", "reject",
    "> ", "$ ",  # common shell/repl prompts
    "?", ":",
)

# Phrases that suggest the agent is still busy (spinner / progress).
_BUSY_HINTS = (
    "thinking", "working", "running", "loading",
    "...", "▌", "█", "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
)


@dataclass
class IdleDetector:
    """Per-agent quiescence tracker."""

    agent_id: str
    quiet_ms: int = field(default_factory=lambda: settings.quiet_ms)
    # Number of consecutive stable-screen samples required.
    stable_samples_required: int = 2
    _last_screen_hash: int = 0
    _stable_count: int = 0
    _last_check_at: float = field(default_factory=time.time)

    def update(self, session: PTYSession) -> None:
        """Call after draining output, to refresh the stable-sample counter."""
        screen = session.capture_visible_screen()
        h = hash(screen)
        if h == self._last_screen_hash:
            self._stable_count += 1
        else:
            self._stable_count = 0
            self._last_screen_hash = h
        self._last_check_at = time.time()

    def is_idle(self, session: PTYSession) -> bool:
        """Best-effort: is this terminal likely waiting for input?"""
        if not session.is_alive():
            return False
        # 1. No new output for a while.
        if not session.is_quiet(self.quiet_ms):
            return False
        # 2. Screen has been stable.
        if self._stable_count < self.stable_samples_required:
            return False
        # 3. Heuristic content check on the meaningful part of the screen.
        screen = session.capture_visible_screen().lower()
        # Focus on the last non-empty lines, not the raw tail (which may be
        # all blank if the terminal is mostly empty).
        lines = [ln for ln in screen.splitlines() if ln.strip()]
        tail = "\n".join(lines[-5:])[-300:] if lines else screen[-300:]
        if any(b in tail for b in _BUSY_HINTS):
            return False
        if any(h in tail for h in _PROMPT_HINTS):
            return True
        # 4. Cursor near the bottom input line OR near the last non-empty line.
        try:
            y, _ = session.cursor_position()
            if y >= session.rows - 2:
                return True
            # Also accept cursor on/near the last non-empty line.
            if lines and y >= len(lines) - 2:
                return True
        except Exception:
            pass
        return False

    def reset(self) -> None:
        self._stable_count = 0
        self._last_screen_hash = 0

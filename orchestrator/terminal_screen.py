"""Terminal screen model backed by `pyte`.

Raw PTY output is messy (ANSI colors, cursor moves, spinners, overwritten lines,
alternate screen buffers). We feed every byte through a pyte Screen so the LLM
controller sees something close to what a human would see in the terminal,
plus a compact recent-output delta.
"""
from __future__ import annotations

import re
from collections import deque
from threading import Lock

import pyte


# ANSI escape sequence patterns for defense-in-depth sanitization.
# pyte already strips these when rendering screen.display, but this is used
# as a safety net for any code path that handles raw PTY output directly.
_ANSI_CSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")          # CSI sequences
_ANSI_OSC_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")  # OSC sequences
_ANSI_SS2_SS3_RE = re.compile(r"\x1b[NO]")                     # SS2/SS3
_ANSI_SINGLE_RE = re.compile(r"\x1b[=>]")                      # Single shifts
_ANSI_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")    # Other control chars


def sanitize_ansi(text: str) -> str:
    """Strip all ANSI escape sequences and control characters from ``text``.

    This is a defense-in-depth utility. The pyte screen emulator already
    produces clean output via ``screen.display``, but any code path that
    handles raw PTY bytes directly (e.g. logging, recent_output scrollback)
    should run through this to avoid feeding escape sequences to the LLM
    or writing garbled text to audit logs.
    """
    if not text:
        return ""
    out = _ANSI_OSC_RE.sub("", text)
    out = _ANSI_CSI_RE.sub("", out)
    out = _ANSI_SS2_SS3_RE.sub("", out)
    out = _ANSI_SINGLE_RE.sub("", out)
    out = _ANSI_CTRL_RE.sub("", out)
    return out


class TerminalScreen:
    """A thread-safe terminal emulator that maintains the visible screen.

    Call `feed(raw_bytes_or_str)` with whatever the PTY emits, then read
    `visible()` for the rendered screen and `recent_output()` for the last N
    non-empty lines of scrollback.
    """

    def __init__(self, cols: int = 120, rows: int = 40, scrollback_lines: int = 200) -> None:
        self._cols = cols
        self._rows = rows
        self._screen = pyte.Screen(cols, rows)
        self._stream = pyte.Stream(self._screen)
        self._scrollback: deque[str] = deque(maxlen=scrollback_lines)
        self._lock = Lock()
        # Raw bytes accumulator for the current "delta" since last reset.
        self._delta_buf: list[str] = []

    @property
    def cols(self) -> int:
        return self._cols

    @property
    def rows(self) -> int:
        return self._rows

    def resize(self, cols: int, rows: int) -> None:
        with self._lock:
            self._cols, self._rows = cols, rows
            self._screen = pyte.Screen(cols, rows)
            self._stream = pyte.Stream(self._screen)

    def feed(self, data: str) -> None:
        if not data:
            return
        with self._lock:
            self._stream.feed(data)
            self._delta_buf.append(data)
            # Track non-empty lines for scrollback.
            for line in data.splitlines():
                if line.strip():
                    self._scrollback.append(line.rstrip())

    def visible(self) -> str:
        """Return the current visible screen as a string (top to bottom)."""
        with self._lock:
            # screen.display is a list of strings, one per row.
            return "\n".join(self._screen.display)

    def cursor_position(self) -> tuple[int, int]:
        """Return (row, col) of the cursor (0-indexed)."""
        with self._lock:
            c = self._screen.cursor
            return (c.y, c.x)

    def recent_output(self, n: int = 20) -> str:
        """Return the last N non-empty scrollback lines (ANSI-sanitized)."""
        with self._lock:
            lines = list(self._scrollback)[-n:]
        return "\n".join(sanitize_ansi(line) for line in lines)

    def take_delta(self) -> str:
        """Return and clear the raw output accumulated since the last call."""
        with self._lock:
            out = "".join(self._delta_buf)
            self._delta_buf.clear()
            return out

    def looks_like_prompt(self) -> bool:
        """Heuristic: is the cursor on the last row near the bottom?"""
        with self._lock:
            y, _x = (self._screen.cursor.y, self._screen.cursor.x)
            return y >= self._rows - 2

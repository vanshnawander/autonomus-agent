"""PTY-based autonomous orchestrator for Devin CLI agents.

Implements the architecture from spec.md: spawn `devin` CLI processes inside
PTYs, render their terminals with pyte, detect idle states, and let an LLM
controller decide what keystrokes to send next. A central orchestrator mediates
handoffs between agents (e.g. literature-survey -> reviewer -> methodology ->
experiment-executor -> reviewer -> paper-writer).
"""

"""Registry of CLI-agent adapters (plugins).

Built-in adapters: devin, opencode, codex, claude-code. Third-party adapters
are loaded from DEVIN_ORCH_AGENT_PLUGINS, a comma-separated list of
``package.module:ClassName`` (or bare ``package.module`` whose import calls
``register_adapter``). See docs/AGENT_PLUGINS.md.
"""
from __future__ import annotations

import importlib
import logging
import os
from typing import Optional

from .base import AgentAdapter, Capabilities, LaunchContext, MenuState, StartupAction
from .claude_code import ClaudeCodeAdapter
from .codex import CodexAdapter
from .devin import DevinAdapter
from .opencode import OpenCodeAdapter

log = logging.getLogger(__name__)

_REGISTRY: dict[str, AgentAdapter] = {}
_ALIASES = {"claude": "claude-code", "claudecode": "claude-code", "claude_code": "claude-code", "open-code": "opencode"}


def register_adapter(adapter: AgentAdapter) -> AgentAdapter:
    if not adapter.name:
        raise ValueError("adapter must define a name")
    _REGISTRY[adapter.name] = adapter
    return adapter


def _load_external_plugins() -> None:
    for spec in filter(None, (s.strip() for s in os.environ.get("DEVIN_ORCH_AGENT_PLUGINS", "").split(","))):
        module_name, _, attr = spec.partition(":")
        try:
            module = importlib.import_module(module_name)
            if attr:
                register_adapter(getattr(module, attr)())
        except Exception:  # noqa: BLE001 - one broken plugin must not stop the server
            log.exception("Failed to load agent plugin %s", spec)


for _adapter in (DevinAdapter(), OpenCodeAdapter(), CodexAdapter(), ClaudeCodeAdapter()):
    register_adapter(_adapter)
_load_external_plugins()


def normalize_cli_name(name: Optional[str]) -> Optional[str]:
    if name is None:
        return None
    key = name.strip().lower()
    return _ALIASES.get(key, key)


def get_adapter(name: Optional[str] = None) -> AgentAdapter:
    from ..config import settings

    key = normalize_cli_name(name) or normalize_cli_name(settings.default_agent_cli) or "devin"
    try:
        return _REGISTRY[key]
    except KeyError:
        raise KeyError(f"unknown agent CLI {name!r}; available: {', '.join(sorted(_REGISTRY))}") from None


def list_adapters() -> list[AgentAdapter]:
    return list(_REGISTRY.values())


__all__ = [
    "AgentAdapter",
    "Capabilities",
    "LaunchContext",
    "MenuState",
    "StartupAction",
    "get_adapter",
    "list_adapters",
    "normalize_cli_name",
    "register_adapter",
]

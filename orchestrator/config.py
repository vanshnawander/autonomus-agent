"""Configuration for the orchestrator.

All values can be overridden via environment variables (DEVIN_ORCH_* prefix).
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv() -> None:
    """Load `.env` from the repo root if python-dotenv is available.

    Keeps secrets (OPENROUTER_API_KEY etc.) out of shell profiles. Values in
    the real environment always win over the file.
    """
    try:
        from dotenv import load_dotenv  # type: ignore
    except ImportError:
        return
    root = Path(__file__).resolve().parent.parent
    load_dotenv(root / ".env", override=False)


_load_dotenv()


def _env(key: str, default: str) -> str:
    return os.environ.get(key, default)


@dataclass
class Settings:
    # --- PTY / terminal ---
    devin_command: str = field(
        default_factory=lambda: _env("DEVIN_ORCH_DEVIN_COMMAND", "devin")
    )
    # Extra args passed to every spawned `devin` process.
    # Session mode selects Devin permissions; generic extra args contain only transport options so
    # the Ox controller and outer SafetyGate can accept, reject, or redirect them.
    devin_extra_args: str = field(
        default_factory=lambda: _env("DEVIN_ORCH_DEVIN_EXTRA_ARGS", "--respect-workspace-trust false")
    )
    # Model used inside every spawned Devin role session. Devin accepts fuzzy
    # model names; this is passed as `--model <name>` at process startup.
    devin_model: str = field(
        default_factory=lambda: _env("DEVIN_ORCH_DEVIN_MODEL", "glm-5.2")
    )
    # If True, append `--export <dir>` so devin writes a full conversation
    # transcript per agent into log_dir/<session>/traces/.
    devin_export_traces: bool = field(
        default_factory=lambda: _env("DEVIN_ORCH_EXPORT_TRACES", "true").lower()
        in ("1", "true", "yes")
    )
    terminal_cols: int = field(default_factory=lambda: int(_env("DEVIN_ORCH_COLS", "120")))
    terminal_rows: int = field(default_factory=lambda: int(_env("DEVIN_ORCH_ROWS", "40")))

    # --- Idle detection ---
    # Milliseconds of no new PTY output before we consider the terminal "quiet"
    # and ask the LLM controller what to do.
    quiet_ms: int = field(default_factory=lambda: int(_env("DEVIN_ORCH_QUIET_MS", "1200")))
    # How often the control loop polls the PTY (seconds).
    poll_interval_s: float = field(
        default_factory=lambda: float(_env("DEVIN_ORCH_POLL_S", "0.1"))
    )
    # Max consecutive low-confidence "wait" decisions before escalating to human.
    max_low_confidence_waits: int = field(
        default_factory=lambda: int(_env("DEVIN_ORCH_MAX_LOW_CONF_WAITS", "3"))
    )
    # Max consecutive idle->wait decisions without any text input before
    # escalating to human (stuck-session detection). 0 = disabled.
    max_idle_waits_without_input: int = field(
        default_factory=lambda: int(_env("DEVIN_ORCH_MAX_IDLE_WAITS", "30"))
    )
    # Max retries when an agent process dies unexpectedly. 0 = no retry.
    max_retries: int = field(
        default_factory=lambda: int(_env("DEVIN_ORCH_MAX_RETRIES", "2"))
    )
    # Per-agent hard timeout in seconds. 0 = no timeout.
    agent_timeout_s: int = field(
        default_factory=lambda: int(_env("DEVIN_ORCH_AGENT_TIMEOUT", "0"))
    )

    # --- LLM controller ---
    # OpenAI-compatible client. Defaults to OpenRouter; point base_url at OpenAI,
    # a local server, Azure, etc. by setting DEVIN_ORCH_LLM_BASE_URL.
    llm_base_url: str = field(
        default_factory=lambda: _env("DEVIN_ORCH_LLM_BASE_URL", "https://openrouter.ai/api/v1")
    )
    llm_api_key: str = field(
        default_factory=lambda: _env(
            "DEVIN_ORCH_LLM_API_KEY", os.environ.get("OPENROUTER_API_KEY", "")
        )
    )
    llm_model: str = field(
        default_factory=lambda: _env("DEVIN_ORCH_LLM_MODEL", "stealth/ox-alpha")
    )
    llm_temperature: float = field(
        default_factory=lambda: float(_env("DEVIN_ORCH_LLM_TEMP", "0.2"))
    )
    # Optional output cap for the controller. 0 means do not send a max_tokens
    # limit and let the provider/model apply its own context/output allowance.
    llm_max_tokens: int = field(default_factory=lambda: int(_env("DEVIN_ORCH_LLM_MAX_TOKENS", "0")))

    # --- Safety ---
    # If True, the controller is allowed to auto-approve low/medium risk actions.
    # High risk always escalates to a human regardless.
    allow_auto_approve: bool = field(
        default_factory=lambda: _env("DEVIN_ORCH_AUTO_APPROVE", "true").lower()
        in ("1", "true", "yes")
    )

    # --- Storage ---
    log_dir: Path = field(
        default_factory=lambda: Path(
            _env("DEVIN_ORCH_LOG_DIR", str(Path(__file__).resolve().parent.parent / "logs"))
        )
    )
    workspace_root: Path = field(
        default_factory=lambda: Path(
            _env("DEVIN_ORCH_WORKSPACE_ROOT", str(Path(__file__).resolve().parent.parent / "runs"))
        )
    )
    python_executable: str = field(
        default_factory=lambda: _env("DEVIN_ORCH_PYTHON", sys.executable)
    )
    conda_env: str = field(
        default_factory=lambda: _env("DEVIN_ORCH_CONDA_ENV", os.environ.get("CONDA_DEFAULT_ENV", ""))
    )
    searxng_url: str = field(
        default_factory=lambda: _env("SEARXNG_URL", "http://127.0.0.1:8080")
    )
    server_inventory_file: Path = field(
        default_factory=lambda: Path(
            _env("DEVIN_ORCH_SERVERS_FILE", str(Path(__file__).resolve().parent.parent / "servers.json"))
        )
    )

    # --- Server ---
    host: str = field(default_factory=lambda: _env("DEVIN_ORCH_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(_env("DEVIN_ORCH_PORT", "8765")))

    def __post_init__(self) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.workspace_root.mkdir(parents=True, exist_ok=True)


settings = Settings()

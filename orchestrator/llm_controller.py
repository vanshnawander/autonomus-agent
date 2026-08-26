"""LLM controller.

The controller is the brain. Each turn it receives a compact snapshot of one
agent's terminal state and returns a single structured JSON action. It never
runs inside the terminal — it watches terminals and decides what to send.

We use the OpenAI client (works against OpenAI, OpenRouter, a local server, etc.
via DEVIN_ORCH_LLM_BASE_URL). The response is parsed into `ControllerDecision`
with a strict schema; on any parse failure we fall back to a safe "wait".
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from openai import OpenAI

from .config import settings
from .prompts import CONTROLLER_SYSTEM_PROMPT
from .schemas import ActionType, AgentState, ControllerDecision, Risk

log = logging.getLogger(__name__)


# The controller's system prompt is imported from prompts.py (single source of
# truth for all prompt text). Kept as a module-level alias for backward compat.
SYSTEM_PROMPT = CONTROLLER_SYSTEM_PROMPT

# The JSON schema we ask the model to fill. We also validate with pydantic.
_RESPONSE_SCHEMA = {
    "type": "object",
    "required": ["state", "action", "reason"],
    "properties": {
        "state": {
            "type": "string",
            "enum": [s.value for s in AgentState],
        },
        "action": {
            "type": "string",
            "enum": [a.value for a in ActionType],
        },
        "target_agent": {"type": ["string", "null"]},
        "text": {"type": ["string", "null"]},
        "key": {"type": ["string", "null"]},
        "duration_ms": {"type": ["integer", "null"]},
        "confidence": {"type": "number"},
        "risk": {
            "type": "string",
            "enum": [r.value for r in Risk],
        },
        "reason": {"type": "string"},
    },
}


class LLMController:
    """Calls the LLM and returns a `ControllerDecision`."""

    def __init__(self) -> None:
        kwargs = {"api_key": settings.llm_api_key or "missing"}
        if settings.llm_base_url:
            kwargs["base_url"] = settings.llm_base_url
        self._client = OpenAI(**kwargs)
        self._model = settings.llm_model

    def decide(self, snapshot: dict, visible_terminal: str, recent_output: str) -> ControllerDecision:
        """Ask the LLM for the next action. Always returns a ControllerDecision."""
        user_msg = json.dumps(
            {
                **snapshot,
                "visible_terminal": visible_terminal,
                "recent_output": recent_output,
            },
            ensure_ascii=False,
            indent=2,
        )
        try:
            request = {
                "model": self._model,
                "temperature": settings.llm_temperature,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": CONTROLLER_SYSTEM_PROMPT},
                    {
                        "role": "system",
                        "content": (
                            "Respond with a JSON object matching this schema:\n"
                            + json.dumps(_RESPONSE_SCHEMA)
                        ),
                    },
                    {"role": "user", "content": user_msg},
                ],
            }
            if settings.llm_max_tokens > 0:
                request["max_tokens"] = settings.llm_max_tokens
            resp = self._client.chat.completions.create(**request)
            raw = resp.choices[0].message.content or "{}"
            data = json.loads(raw)
            return ControllerDecision.model_validate(data)
        except Exception as exc:  # noqa: BLE001 - we must never crash the loop
            log.warning("LLM controller failed (%s); returning safe wait", exc)
            return ControllerDecision(
                state=AgentState.thinking,
                action=ActionType.wait,
                duration_ms=1000,
                confidence=0.0,
                risk=Risk.unknown,
                reason=f"controller error: {exc}",
            )


# A no-LLM fallback controller used in tests / when no API key is configured.
# It only knows how to wait and escalate — never sends input autonomously.
class NullController:
    """Safe stub: always waits, escalates to human on idle."""

    def decide(self, snapshot: dict, visible_terminal: str, recent_output: str) -> ControllerDecision:
        return ControllerDecision(
            state=AgentState.thinking,
            action=ActionType.wait,
            duration_ms=1000,
            confidence=0.0,
            risk=Risk.low,
            reason="null controller: no LLM configured",
        )


def make_controller() -> LLMController | NullController:
    if settings.llm_api_key and settings.llm_api_key != "missing":
        return LLMController()
    log.warning(
        "No DEVIN_ORCH_LLM_API_KEY / OPENAI_API_KEY set; using NullController. "
        "The orchestrator will run but never send autonomous input."
    )
    return NullController()

"""Safety layer: risk classification + approval gates.

The LLM controller must never auto-approve destructive / external / financial /
production / secret-related actions. This module:

  - classifies a candidate text/action as low / medium / high / unknown risk
  - maintains an approval queue for high-risk actions
  - exposes a synchronous "should we proceed?" check used by the control loop
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from threading import Lock
from typing import Optional

from .schemas import ApprovalItem, ControllerDecision, Risk


# Patterns that mark an action as HIGH risk regardless of what the LLM says.
_HIGH_RISK_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\brm\s+-rf\b",
        r"\brm\s+-r\b",
        r"\bgit\s+push\b",
        r"\bgit\s+push\s+--force\b",
        r"\bgit\s+push\s+.*--force\b",
        r"\bforce[-_]?push\b",
        r"\bnpm\s+publish\b",
        r"\bpip\s+install\b.*--user",
        r"\bterraform\s+apply\b",
        r"\bterraform\s+destroy\b",
        r"\bkubectl\s+delete\b",
        r"\bdocker\s+rm\b",
        r"\bgit\s+reset\s+--hard\b",
        r"\bdrop\s+(table|database|schema)\b",
        r"\bdelete\s+from\b",
        r"\btruncate\b",
        r"\bcreate\s+extension\b",
        r"\bdeploy\b.*production",
        r"\bproduction\b.*deploy",
        r"\bcurl\b.*\|\s*(bash|sh)\b",
        r"\bwget\b.*\|\s*(bash|sh)\b",
        r"\bsudo\b",
        r"\bchmod\b.*777",
        r"\bchown\b",
        r"\bmkfs\b",
        r"\bdd\b.*of=/dev/",
        r"\bkill\b.*-9",
        r"\bkillall\b",
        r"\bpkill\b",
        r"\bshutdown\b",
        r"\breboot\b",
        r"\b--force\b",
        r"\b--dangerous\b",
        r"\b--yolo\b",
        r"(?:^|\n|[;&|]\s*)eval\s+",
        # Generic words such as "token" occur constantly in ML papers.
        r"\b(?:cat|less|more|head|tail|sed|grep|rg|cp|mv|source|open|read)\b[^\n|;&]*(?:\.env\b|id_rsa\b|\.ssh\b|\.aws\b)",
        r"\b(?:api[_-]?key|secret|password|credential)\b\s*(?:=|:)",
        r"\b(?:printenv|env)\b[^\n|;&]*(?:api[_-]?key|secret|password|token|credential)",
        r"\bexec\b.*\b(bash|sh|python)\b",
    )
)

# Patterns that bump an action to MEDIUM risk.
_MEDIUM_RISK_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bgit\s+(commit|merge|rebase|reset)\b",
        r"\bnpm\s+install\b",
        r"\bpip\s+install\b",
        r"\bapt\b",
        r"\bbrew\s+install\b",
        r"\bdocker\b",
        r"\bmake\b",
        r"\bmv\b",
        r"\bcp\b",
        r"\btouch\b",
        r"\bmkdir\b",
        r"\b>\s*/",
        r"\b>>\s*/",
        # Editing user config directories that may contain secrets.
        r"\b~/.config\b",
    )
)


def classify_risk(text: Optional[str], decision: Optional[ControllerDecision] = None) -> Risk:
    """Classify the risk of sending `text` to a terminal.

    The LLM's own `risk` field is taken as a lower bound — we can only ever
    *raise* it, never lower it, based on pattern matching. High risk always
    wins.
    """
    if not text:
        base = Risk.low
    else:
        low = text.lower()
        if any(p.search(low) for p in _HIGH_RISK_PATTERNS):
            base = Risk.high
        elif any(p.search(low) for p in _MEDIUM_RISK_PATTERNS):
            base = Risk.medium
        else:
            base = Risk.low
    if decision is not None:
        order = {Risk.low: 0, Risk.medium: 1, Risk.high: 2, Risk.unknown: 0}
        if order.get(decision.risk, 0) > order.get(base, 0):
            base = decision.risk
    return base


@dataclass
class SafetyGate:
    """Approval queue + policy check."""

    allow_auto_approve: bool = False
    _queue: dict[str, ApprovalItem] = field(default_factory=dict)
    _resolutions: dict[str, bool] = field(default_factory=dict)
    _lock: Lock = field(default_factory=Lock)

    def check(
        self,
        session_id: str,
        agent_id: str,
        decision: ControllerDecision,
        terminal_context: str = "",
        allow_auto_approve: Optional[bool] = None,
    ) -> tuple[bool, Optional[ApprovalItem]]:
        """Decide whether the control loop may execute `decision` right now.

        Returns (may_proceed, pending_approval). If may_proceed is False the
        loop must wait for a human to approve via the API.
        """
        text = decision.text
        # A bare `y`/Enter can approve a dangerous command shown only in the
        # terminal. Classify both the proposed keystroke and the prompt context.
        risk = classify_risk("\n".join(part for part in (terminal_context[-2000:], text or "") if part), decision)

        if risk == Risk.high:
            item = ApprovalItem(
                id=str(uuid.uuid4()),
                session_id=session_id,
                agent_id=agent_id,
                question=(
                    f"Agent {agent_id} wants to send high-risk input: "
                    f"{(text or '<action>')[:200]}"
                ),
                risk=risk,
                decision=decision,
            )
            with self._lock:
                self._queue[item.id] = item
            return False, item

        effective_auto_approve = (
            self.allow_auto_approve if allow_auto_approve is None else allow_auto_approve
        )
        if risk == Risk.medium and not effective_auto_approve:
            item = ApprovalItem(
                id=str(uuid.uuid4()),
                session_id=session_id,
                agent_id=agent_id,
                question=(
                    f"Agent {agent_id} wants to send medium-risk input: "
                    f"{(text or '<action>')[:200]}"
                ),
                risk=risk,
                decision=decision,
            )
            with self._lock:
                self._queue[item.id] = item
            return False, item

        return True, None

    def resolve(
        self,
        approval_id: str,
        approved: bool,
        session_id: Optional[str] = None,
    ) -> Optional[ApprovalItem]:
        """Resolve an item and retain the verdict for its waiting control loop."""
        with self._lock:
            item = self._queue.get(approval_id)
            if item is None or (session_id is not None and item.session_id != session_id):
                return None
            self._queue.pop(approval_id)
            self._resolutions[approval_id] = approved
            return item

    def consume_resolution(self, approval_id: str) -> Optional[bool]:
        """Return and forget a human verdict once the waiting loop observes it."""
        with self._lock:
            return self._resolutions.pop(approval_id, None)

    def pending(self, session_id: Optional[str] = None) -> list[ApprovalItem]:
        with self._lock:
            items = list(self._queue.values())
        if session_id:
            items = [i for i in items if i.session_id == session_id]
        return items

    def pending_for_agent(self, session_id: str, agent_id: str) -> Optional[ApprovalItem]:
        for item in self.pending(session_id):
            if item.agent_id == agent_id:
                return item
        return None

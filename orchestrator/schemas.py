"""Pydantic models for API request/response bodies and the LLM action schema.

The LLM controller returns a strict JSON object matching `ControllerDecision`.
Everything else here is for the FastAPI surface.
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums shared between the controller, the safety layer, and the API.
# ---------------------------------------------------------------------------


class AgentState(str, Enum):
    thinking = "thinking"
    waiting_for_input = "waiting_for_input"
    blocked = "blocked"
    needs_human = "needs_human"
    done = "done"
    unsafe = "unsafe"
    error = "error"
    stopped = "stopped"


class ActionType(str, Enum):
    wait = "wait"
    send_text = "send_text"
    send_line = "send_line"
    press_enter = "press_enter"
    press_key = "press_key"
    send_ctrl_c = "send_ctrl_c"
    send_escape = "send_escape"
    ask_human = "ask_human"
    ask_other_agent = "ask_other_agent"
    transfer_to_agent = "transfer_to_agent"
    mark_done = "mark_done"
    terminate = "terminate"


class Risk(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"
    unknown = "unknown"


class ApprovalMode(str, Enum):
    manual = "manual"
    autonomous = "autonomous"


class FeedbackMode(str, Enum):
    immediate = "immediate"      # type straight into the waiting terminal
    context = "context"          # store for the controller to use next turn
    interrupt = "interrupt"      # Ctrl+C then send the message


class AgentStatus(str, Enum):
    idle = "idle"
    running = "running"
    waiting = "waiting"
    paused = "paused"
    done = "done"
    error = "error"
    stopped = "stopped"


# ---------------------------------------------------------------------------
# LLM controller decision (strict JSON schema).
# ---------------------------------------------------------------------------


class ControllerDecision(BaseModel):
    """The single action the LLM controller chooses each turn."""

    state: AgentState = Field(..., description="Current inferred terminal/agent state")
    action: ActionType = Field(..., description="The action to take this turn")
    target_agent: Optional[str] = Field(
        None, description="Which agent this action targets (for multi-agent ops)"
    )
    text: Optional[str] = Field(None, description="Text to send (for send_text/send_line/ask_other_agent)")
    key: Optional[str] = Field(None, description="Key name for press_key, e.g. 'enter', 'esc', 'y'")
    duration_ms: Optional[int] = Field(None, description="How long to wait when action=wait")
    confidence: float = Field(0.0, ge=0.0, le=1.0, description="Controller confidence 0..1")
    risk: Risk = Risk.unknown
    reason: str = Field(..., description="Short human-readable justification")


# ---------------------------------------------------------------------------
# API request bodies.
# ---------------------------------------------------------------------------


class AgentSpec(BaseModel):
    agent_id: str = Field(
        ..., min_length=1, max_length=80, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$",
        description="Unique filesystem-safe id within the session",
    )
    role: str = Field(..., description="Role key, must match a role in orchestrator/roles.py")
    command: Optional[str] = Field(
        None, description="Override the spawn command (defaults to `devin` + role prompt)"
    )
    cwd: Optional[str] = Field(None, description="Working directory for the agent")
    resume_session_id: Optional[str] = Field(
        None, description="Devin session id to resume with `devin -r <id>` instead of starting fresh"
    )
    extra_prompt: Optional[str] = Field(
        None, description="Additional prompt text appended to the role's system prompt at spawn"
    )


class CreateSessionRequest(BaseModel):
    session_id: str = Field(
        ..., min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$",
        description="Filesystem-safe id for the whole project run",
    )
    agents: list[AgentSpec] = Field(..., min_length=1)
    goal: str = Field(..., min_length=1, description="Top-level goal for the orchestrator")
    constraints: list[str] = Field(default_factory=list)
    approval_mode: ApprovalMode = ApprovalMode.manual
    workspace: Optional[str] = Field(
        None, max_length=200, description="Project directory below DEVIN_ORCH_WORKSPACE_ROOT"
    )
    project_brief: Optional[str] = Field(
        None, description="PROJECT_BRIEF.md content written before agents start"
    )


class FeedbackRequest(BaseModel):
    message: str
    target_agent: Optional[str] = None
    mode: FeedbackMode = FeedbackMode.context


class ForceInputRequest(BaseModel):
    type: ActionType = ActionType.send_line
    text: Optional[str] = None
    key: Optional[str] = None


class ApprovalRequest(BaseModel):
    approved: bool
    reason: Optional[str] = None


# ---------------------------------------------------------------------------
# API response bodies.
# ---------------------------------------------------------------------------


class AgentStateResponse(BaseModel):
    agent_id: str
    role: str
    status: AgentStatus
    visible_screen: str
    recent_output: str
    last_decision: Optional[ControllerDecision] = None
    devin_session_id: Optional[str] = None
    pending_approval: Optional[str] = None


class SessionResponse(BaseModel):
    session_id: str
    goal: str
    agents: dict[str, AgentStateResponse] = Field(default_factory=dict)
    active_agent: Optional[str] = None
    done: bool = False
    approval_mode: ApprovalMode = ApprovalMode.manual
    workspace: Optional[str] = None
    pipeline: list[str] = Field(default_factory=list)
    stage_index: int = 0


class SessionSummary(BaseModel):
    """Unified summary row for the dashboard sidebar.

    Merges live (in-memory) sessions with recorded (on-disk) sessions so the
    UI can show past runs even when the orchestrator process has restarted.
    """

    session_id: str
    goal: str = ""
    active_agent: Optional[str] = None
    done: bool = False
    live: bool = False
    agent_roles: list[str] = Field(default_factory=list)
    agent_count: int = 0
    events_count: int = 0
    created_at: Optional[float] = None
    last_event_at: Optional[float] = None
    approval_mode: ApprovalMode = ApprovalMode.manual
    workspace: Optional[str] = None
    pipeline: list[str] = Field(default_factory=list)
    stage_index: int = 0


class Event(BaseModel):
    type: str
    session_id: str
    agent_id: Optional[str] = None
    data: Any = None
    timestamp: float = 0.0


class ApprovalItem(BaseModel):
    id: str
    session_id: str
    agent_id: str
    question: str
    risk: Risk
    decision: Optional[ControllerDecision] = None

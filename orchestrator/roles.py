"""Agent role definitions for the research pipeline.

Each role maps to:
- a system prompt (loaded from ``prompts.py`` — the single source of truth for
  all prompt text) that gets fed to a fresh `devin` session at spawn time
- the allowed actions the orchestrator will permit that agent to take
- which role(s) this agent may hand off to

The pipeline:
    literature-survey -> reviewer -> methodology -> experiment-executor
                    -> reviewer -> paper-writer

The reviewer is a gate: it either approves (handoff to next stage) or sends
the current agent back to search / redesign / re-run.

All prompt text lives in ``orchestrator/prompts.py``. This module only defines
the structural properties of each role (allowed actions, handoff graph, gate
flag) and references the prompt by role key.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .prompts import ROLE_PROMPTS, build_agent_prompt


@dataclass(frozen=True)
class Role:
    key: str
    title: str
    allowed_actions: tuple[str, ...]
    # Roles this agent may hand off to (by role key). The orchestrator enforces this.
    can_handoff_to: tuple[str, ...] = field(default_factory=tuple)
    # Whether this role is a reviewer/gate that can send work back.
    is_gate: bool = False

    @property
    def system_prompt(self) -> str:
        """The role-specific prompt text (without the shared base).

        For the full composed prompt (base + role + extra), use
        ``build_agent_prompt(self.key, extra_prompt)``.
        """
        return ROLE_PROMPTS[self.key]

    def full_prompt(self, extra_prompt: str | None = None) -> str:
        """Compose the full spawn-time prompt: base + role + extra."""
        return build_agent_prompt(self.key, extra_prompt)


LITERATURE_SURVEY = Role(
    key="literature-survey",
    title="Literature Survey Agent",
    allowed_actions=("edit_files", "run_readonly_commands", "web_search", "ask_questions"),
    can_handoff_to=("reviewer",),
)

REVIEWER = Role(
    key="reviewer",
    title="Reviewer Agent",
    allowed_actions=("inspect_files", "run_readonly_commands", "web_search", "suggest_changes"),
    can_handoff_to=("literature-survey", "methodology", "experiment-executor", "paper-writer"),
    is_gate=True,
)

METHODOLOGY = Role(
    key="methodology",
    title="Methodology Design Agent",
    allowed_actions=("edit_files", "run_readonly_commands", "ask_questions"),
    can_handoff_to=("reviewer",),
)

EXPERIMENT_EXECUTOR = Role(
    key="experiment-executor",
    title="Experiment Execution Agent",
    allowed_actions=("edit_files", "run_tests", "run_commands", "ask_questions"),
    can_handoff_to=("reviewer",),
)

PAPER_WRITER = Role(
    key="paper-writer",
    title="Paper Writing Agent",
    allowed_actions=("edit_files", "run_readonly_commands", "ask_questions"),
    can_handoff_to=("reviewer",),
)


ROLES: dict[str, Role] = {
    r.key: r for r in (
        LITERATURE_SURVEY,
        REVIEWER,
        METHODOLOGY,
        EXPERIMENT_EXECUTOR,
        PAPER_WRITER,
    )
}

# Canonical order of the non-reviewer (work) stages.
WORK_STAGES: tuple[str, ...] = (
    "literature-survey",
    "methodology",
    "experiment-executor",
    "paper-writer",
)
REVIEWER_KEY = "reviewer"


def build_pipeline(declared_roles: set[str]) -> list[str]:
    """Build the ordered pipeline for a set of declared roles.

    For each declared work stage (in canonical order), append the stage and then
    a reviewer gate (if the reviewer role is declared). The reviewer after the
    final work stage is included so the last deliverable gets reviewed too.

    Examples:
      {literature-survey, reviewer}
          -> [literature-survey, reviewer]
      {literature-survey, reviewer, methodology, experiment-executor, paper-writer}
          -> [literature-survey, reviewer, methodology, reviewer,
              experiment-executor, reviewer, paper-writer, reviewer]
      {literature-survey}  (no reviewer declared)
          -> [literature-survey]
    """
    has_reviewer = REVIEWER_KEY in declared_roles
    pipeline: list[str] = []
    for stage in WORK_STAGES:
        if stage in declared_roles:
            pipeline.append(stage)
            if has_reviewer:
                pipeline.append(REVIEWER_KEY)
    # Fallback: if none of the canonical work stages were declared, just use the
    # declared roles in arbitrary but stable order.
    if not pipeline:
        pipeline = sorted(declared_roles)
    return pipeline


def get_role(key: str) -> Role:
    if key not in ROLES:
        raise KeyError(f"Unknown role: {key!r}. Known: {list(ROLES)}")
    return ROLES[key]

// Derives the pipeline stepper model (groups of work stage + its review gates)
// from the session state and the hand-off history.
import { isGateRole, roleLabel } from "./format";
import type { AgentStateResponse, Event, HandoffRecord } from "./types";

export type StepState = "done" | "active" | "stopped" | "error" | "pending";

export interface PipelineStep {
  index: number;
  role: string;
  label: string;
  state: StepState;
  agentId?: string;
  /** Work stage: times work was sent back to it. Gate: times this gate rejected the group's work. */
  rejections: number;
  lastReason?: string;
}

export interface PipelineGroup {
  /** Role of the work stage that heads the group (or the first gate when there is none). */
  role: string;
  label: string;
  steps: PipelineStep[];
  state: StepState;
}

const WORK_STAGES = ["literature-survey", "methodology", "experiment-executor", "paper-writer"];

/** Fallback when an older server doesn't report the pipeline. */
export function inferPipeline(agents: Record<string, AgentStateResponse>): string[] {
  const roles = new Set(
    Object.values(agents)
      .filter((agent) => agent.kind !== "auxiliary")
      .map((agent) => agent.role),
  );
  const pipeline: string[] = [];
  for (const stage of WORK_STAGES) {
    if (!roles.has(stage)) continue;
    pipeline.push(stage);
    if (roles.has("critic")) pipeline.push("critic");
    if (roles.has("reviewer")) pipeline.push("reviewer");
  }
  return pipeline.length ? pipeline : Array.from(roles);
}

export function isRejectReason(reason?: string | null): boolean {
  if (!reason) return false;
  if (/^\s*approv/i.test(reason)) return false;
  return /^\s*reject/i.test(reason) || /\bREJECT(ED)?\b/.test(reason) || /\brejected\b/i.test(reason);
}

interface RejectionStats {
  /** work role -> count */
  returns: Record<string, number>;
  /** `${gateRole}|${workRole}` -> count */
  gate: Record<string, number>;
  lastReason: Record<string, string>;
}

export function rejectionStats(
  agents: Record<string, AgentStateResponse>,
  handoffs: HandoffRecord[],
  events: Event[],
): RejectionStats {
  const stats: RejectionStats = { returns: {}, gate: {}, lastReason: {} };
  const roleOf = (id: string) => agents[id]?.role ?? id;
  const add = (gateRole: string, workRole: string, reason: string) => {
    stats.returns[workRole] = (stats.returns[workRole] ?? 0) + 1;
    const key = `${gateRole}|${workRole}`;
    stats.gate[key] = (stats.gate[key] ?? 0) + 1;
    if (reason) {
      stats.lastReason[workRole] = reason;
      stats.lastReason[key] = reason;
    }
  };
  if (handoffs.length) {
    for (const h of handoffs) {
      const from = roleOf(h.from_agent);
      const to = roleOf(h.to_agent);
      if (isGateRole(from) && !isGateRole(to) && isRejectReason(h.reason)) {
        add(from, to, h.reason.replace(/^\s*reject(ed)?\s*:?\s*/i, ""));
      }
    }
  } else {
    for (const e of events) {
      if (e.type !== "critic_rejected" && e.type !== "reviewer_rejected") continue;
      const d = (e.data ?? {}) as { stage?: string; reason?: string };
      if (!d.stage) continue;
      add(e.type === "critic_rejected" ? "critic" : "reviewer", d.stage, d.reason ?? "");
    }
  }
  return stats;
}

export function buildPipeline(opts: {
  pipeline?: string[];
  stageIndex?: number;
  done?: boolean;
  agents: Record<string, AgentStateResponse>;
  handoffs: HandoffRecord[];
  events: Event[];
}): PipelineGroup[] {
  const { agents, handoffs, events } = opts;
  const pipeline = opts.pipeline?.length ? opts.pipeline : inferPipeline(agents);
  const stageIndex = opts.done ? pipeline.length : (opts.stageIndex ?? 0);
  const stats = rejectionStats(agents, handoffs, events);

  const agentForRole: Record<string, AgentStateResponse> = {};
  for (const agent of Object.values(agents)) {
    if (agent.kind === "auxiliary") continue;
    if (!agentForRole[agent.role] || agent.alive) agentForRole[agent.role] = agent;
  }

  const groups: PipelineGroup[] = [];
  pipeline.forEach((role, index) => {
    const gate = isGateRole(role);
    let group = groups[groups.length - 1];
    if (!gate || !group) {
      group = { role, label: roleLabel(role), steps: [], state: "pending" };
      groups.push(group);
    }
    const agent = agentForRole[role];
    let state: StepState = "pending";
    if (index < stageIndex) state = "done";
    else if (index === stageIndex) {
      if (agent?.status === "error") state = "error";
      else if (agent?.alive) state = "active";
      else state = "stopped";
    }
    const workRole = group.role;
    const key = gate ? `${role}|${workRole}` : role;
    group.steps.push({
      index,
      role,
      label: roleLabel(role),
      state,
      agentId: agent?.agent_id,
      rejections: gate ? (stats.gate[key] ?? 0) : (stats.returns[role] ?? 0),
      lastReason: stats.lastReason[key],
    });
  });

  for (const group of groups) {
    const states = group.steps.map((s) => s.state);
    group.state = states.every((s) => s === "done")
      ? "done"
      : (states.find((s) => s === "active" || s === "stopped" || s === "error") ?? "pending");
  }
  return groups;
}

// Plain-language labels and formatting helpers shared by every page.
import type {
  AgentCliInfo,
  AgentStateResponse,
  AgentStatus,
  ControllerDecision,
  RunStatus,
  SessionSummary,
} from "./types";

// ---------------------------------------------------------------- time

export function fmtRelative(ts?: number | null): string {
  if (!ts) return "never";
  const diff = Math.max(0, Date.now() / 1000 - ts);
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  const days = Math.floor(diff / 86400);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function fmtTime(ts?: number | null): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function fmtDateTime(ts?: number | null): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtBytes(n?: number | null): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- roles & stages

const ROLE_LABELS: Record<string, string> = {
  "literature-survey": "Literature survey",
  methodology: "Methodology",
  "experiment-executor": "Experiments",
  "paper-writer": "Paper writing",
  critic: "Critic review",
  reviewer: "Acceptance review",
};

export const ROLE_OPTIONS = [
  "literature-survey",
  "methodology",
  "experiment-executor",
  "paper-writer",
  "critic",
  "reviewer",
];

/** "experiment-executor" -> "Experiments"; unknown roles are title-cased. */
export function roleLabel(role?: string | null): string {
  if (!role) return "Unknown";
  return ROLE_LABELS[role] ?? role.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function isGateRole(role?: string | null): boolean {
  return role === "critic" || role === "reviewer";
}

/** Short description of what each role does, for tooltips and the wizard. */
export const ROLE_HELP: Record<string, string> = {
  "literature-survey": "Finds and summarises prior work, proposes open problems.",
  methodology: "Designs the study: hypotheses, baselines, metrics, ablations.",
  "experiment-executor": "Writes and runs the experiment code, records results.",
  "paper-writer": "Writes the paper from approved, traceable evidence.",
  critic: "Adversarial check after each stage; rejects weak or unsupported work.",
  reviewer: "Independent acceptance check after the critic approves.",
};

// ---------------------------------------------------------------- agent CLIs

export const FALLBACK_CLIS: AgentCliInfo[] = [
  {
    name: "devin",
    display_name: "Devin",
    description: "Devin CLI coding agent.",
    installed: false,
    command: "devin",
    default_model: null,
    model_hint: "",
    capabilities: { resume: true, trace_export: true, session_id_capture: true, model_selection: true },
    notes: "",
  },
  {
    name: "opencode",
    display_name: "OpenCode",
    description: "OpenCode terminal coding agent.",
    installed: false,
    command: "opencode",
    default_model: null,
    model_hint: "",
    capabilities: { resume: false, trace_export: false, session_id_capture: false, model_selection: true },
    notes: "",
  },
  {
    name: "codex",
    display_name: "Codex",
    description: "OpenAI Codex CLI.",
    installed: false,
    command: "codex",
    default_model: null,
    model_hint: "",
    capabilities: { resume: false, trace_export: false, session_id_capture: false, model_selection: true },
    notes: "",
  },
  {
    name: "claude-code",
    display_name: "Claude Code",
    description: "Anthropic Claude Code CLI.",
    installed: false,
    command: "claude",
    default_model: null,
    model_hint: "",
    capabilities: { resume: false, trace_export: false, session_id_capture: false, model_selection: true },
    notes: "",
  },
];

const CLI_LABELS: Record<string, string> = Object.fromEntries(
  FALLBACK_CLIS.map((cli) => [cli.name, cli.display_name]),
);

export function cliLabel(name?: string | null): string {
  if (!name) return "Devin";
  return CLI_LABELS[name] ?? name;
}

// ---------------------------------------------------------------- agent status

const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "Not started",
  running: "Working",
  waiting: "Waiting",
  paused: "Paused",
  done: "Finished",
  error: "Error",
  stopped: "Stopped",
};

export function agentStatusLabel(agent: Pick<AgentStateResponse, "status" | "alive" | "attention" | "pending_approval">): string {
  if (agent.pending_approval || agent.attention) return "Needs you";
  return AGENT_STATUS_LABEL[agent.status] ?? agent.status;
}

export type Tone = "ok" | "info" | "warn" | "bad" | "muted";

export function agentStatusTone(agent: Pick<AgentStateResponse, "status" | "alive" | "attention" | "pending_approval">): Tone {
  if (agent.pending_approval || agent.attention) return "warn";
  switch (agent.status) {
    case "running":
      return "info";
    case "waiting":
    case "paused":
      return "warn";
    case "done":
      return "ok";
    case "error":
      return "bad";
    default:
      return "muted";
  }
}

// ---------------------------------------------------------------- run status

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  needs_attention: "Needs you",
  running: "Running",
  stopped: "Stopped",
  done: "Completed",
  error: "Failed",
};

export const RUN_STATUS_TONE: Record<RunStatus, Tone> = {
  needs_attention: "warn",
  running: "info",
  stopped: "muted",
  done: "ok",
  error: "bad",
};

/** Server status when provided, otherwise derived from older summary fields. */
export function runStatusOf(s: SessionSummary, approvalSessions?: Set<string>): RunStatus {
  if (s.needs_attention || approvalSessions?.has(s.session_id)) return "needs_attention";
  if (s.status) return s.status;
  if (s.done) return "done";
  if (s.live) return "running";
  return "stopped";
}

/** Current stage role for a session-like object. */
export function currentStageOf(s: {
  current_stage?: string | null;
  pipeline?: string[];
  stage_index?: number;
  done?: boolean;
}): string | null {
  if (s.current_stage) return s.current_stage;
  const pipeline = s.pipeline ?? [];
  const idx = s.stage_index ?? 0;
  if (s.done || idx >= pipeline.length) return null;
  return pipeline[idx] ?? null;
}

/** "Step 5 of 8 · Experiments" style progress text. */
export function stageProgressText(s: {
  current_stage?: string | null;
  pipeline?: string[];
  stage_index?: number;
  done?: boolean;
}): string {
  const pipeline = s.pipeline ?? [];
  if (!pipeline.length) return s.done ? "All stages complete" : "No pipeline recorded";
  const idx = s.stage_index ?? 0;
  if (s.done || idx >= pipeline.length) return pipeline.length === 1 ? "Complete" : `All ${pipeline.length} steps complete`;
  const stage = currentStageOf(s);
  return `Step ${idx + 1} of ${pipeline.length} · ${roleLabel(stage)}`;
}

// ---------------------------------------------------------------- controller

/** Turn a raw controller error ("controller error: Error code: 429 - {...}") into a short phrase. */
export function summarizeControllerError(raw?: string | null): string {
  if (!raw) return "";
  const text = raw.replace(/^controller error:\s*/i, "");
  const code = text.match(/Error code:\s*(\d{3})/i)?.[1] ?? text.match(/\b(4\d\d|5\d\d)\b/)?.[1];
  if (code === "429" || /rate.?limit/i.test(text)) return "rate limited by the LLM provider (429)";
  if (code === "401" || code === "403") return `the LLM provider refused the API key (${code})`;
  if (code === "404") return "the controller model was not found (404)";
  if (code && code.startsWith("5")) return `the LLM provider had a server error (${code})`;
  if (/validation error/i.test(text)) return "the controller returned an answer in the wrong format";
  if (/timeout|timed out/i.test(text)) return "the LLM request timed out";
  if (/connection/i.test(text)) return "could not reach the LLM provider";
  const firstLine = text.split("\n")[0];
  return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
}

export function isControllerErrorDecision(d?: ControllerDecision | null): boolean {
  return !!d?.reason && /^controller error:/i.test(d.reason);
}

const KEY_LABELS: Record<string, string> = {
  enter: "Enter",
  escape: "Esc",
  esc: "Esc",
  tab: "Tab",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  "ctrl+c": "Ctrl-C",
  space: "Space",
  backspace: "Backspace",
};

export function keyLabel(key?: string | null): string {
  if (!key) return "a key";
  return KEY_LABELS[key.toLowerCase()] ?? key;
}

/** One-line description of what a controller decision would do. */
export function describeDecision(d?: ControllerDecision | null): string {
  if (!d) return "";
  switch (d.action) {
    case "wait":
      return "Wait";
    case "send_text":
      return `Type “${truncate(d.text ?? "", 60)}” (without Enter)`;
    case "send_line":
      return `Type “${truncate(d.text ?? "", 60)}” and press Enter`;
    case "press_enter":
      return "Press Enter";
    case "press_key":
      return `Press ${keyLabel(d.key)}`;
    case "send_ctrl_c":
      return "Press Ctrl-C (interrupt)";
    case "send_escape":
      return "Press Esc";
    case "ask_human":
      return "Ask a human";
    case "ask_other_agent":
      return `Ask ${d.target_agent ?? "another agent"}`;
    case "transfer_to_agent":
      return `Hand work to ${d.target_agent ?? "another agent"}`;
    case "mark_done":
      return "Mark this stage as done";
    case "terminate":
      return "Stop the agent";
    default:
      return d.action;
  }
}

// ---------------------------------------------------------------- text

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Strip ANSI escape sequences and stray control characters; normalise CR. */
export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/** Approval questions for CLI menus end with "\n\nTerminal shows:\n<excerpt>". */
export function splitTerminalExcerpt(question?: string | null): { text: string; excerpt: string | null } {
  const q = question ?? "";
  const m = q.match(/\n\s*Terminal shows:\s*\n/);
  if (!m || m.index === undefined) return { text: q, excerpt: null };
  return { text: q.slice(0, m.index).trim(), excerpt: q.slice(m.index + m[0].length).replace(/\s+$/, "") };
}

export function truncate(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

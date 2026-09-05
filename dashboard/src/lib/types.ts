// Types mirroring the FastAPI orchestrator schemas (orchestrator/schemas.py).

export type AgentStatus =
  | "idle"
  | "running"
  | "waiting"
  | "paused"
  | "done"
  | "error"
  | "stopped";

export type ActionType =
  | "wait"
  | "send_text"
  | "send_line"
  | "press_enter"
  | "press_key"
  | "send_ctrl_c"
  | "send_escape"
  | "ask_human"
  | "ask_other_agent"
  | "transfer_to_agent"
  | "mark_done"
  | "terminate";

export type AgentState =
  | "thinking"
  | "waiting_for_input"
  | "blocked"
  | "needs_human"
  | "done"
  | "unsafe"
  | "error"
  | "stopped";

export type Risk = "low" | "medium" | "high" | "unknown";
export type FeedbackMode = "immediate" | "context" | "interrupt";
export type ApprovalMode = "manual" | "autonomous";

export interface ControllerDecision {
  state: AgentState;
  action: ActionType;
  target_agent?: string | null;
  text?: string | null;
  key?: string | null;
  duration_ms?: number | null;
  confidence: number;
  risk: Risk;
  reason: string;
}

export interface AgentStateResponse {
  agent_id: string;
  role: string;
  status: AgentStatus;
  visible_screen: string;
  recent_output: string;
  last_decision?: ControllerDecision | null;
  devin_session_id?: string | null;
  pending_approval?: string | null;
}

export interface SessionResponse {
  session_id: string;
  goal: string;
  agents?: Record<string, AgentStateResponse>;
  active_agent?: string | null;
  done: boolean;
  live?: boolean;
  approval_mode?: ApprovalMode;
  workspace?: string;
  project_brief?: string;
  pipeline?: string[];
  stage_index?: number;
}

export interface SessionSummary {
  session_id: string;
  goal: string;
  active_agent?: string | null;
  done: boolean;
  live: boolean;
  agent_roles: string[];
  agent_count: number;
  events_count: number;
  created_at?: number | null;
  last_event_at?: number | null;
  approval_mode?: ApprovalMode;
  workspace?: string | null;
  pipeline?: string[];
  stage_index?: number;
}

export interface AgentSpec {
  agent_id: string;
  role: string;
  command?: string | null;
  cwd?: string | null;
  resume_session_id?: string | null;
  extra_prompt?: string | null;
}

export interface CreateSessionRequest {
  session_id: string;
  agents: AgentSpec[];
  goal: string;
  constraints?: string[];
  approval_mode: ApprovalMode;
  workspace: string;
  project_brief: string;
}

export interface ApprovalItem {
  id: string;
  session_id: string;
  agent_id: string;
  question: string;
  risk: Risk;
  decision?: ControllerDecision | null;
}

export interface Event {
  type: string;
  session_id: string;
  agent_id?: string | null;
  data?: unknown;
  timestamp: number;
}

export interface HandoffRecord {
  from_agent: string;
  to_agent: string;
  reason: string;
  timestamp: number;
}

export interface PreflightResponse {
  ready: boolean;
  checks: Record<string, { ok: boolean; detail: string }>;
}

export interface HealthResponse {
  status: string;
  devin_command: string;
  devin_model: string;
  llm_model: string;
  llm_max_tokens?: number | null;
  llm_configured: boolean;
  auto_approve: boolean;
  python_executable?: string;
  conda_env?: string;
  workspace_root?: string;
  searxng_url?: string;
  trace_export?: boolean;
  server_inventory_configured?: boolean;
  server_inventory_file?: string;
  sessions: number;
}

export interface AgentAttemptFiles {
  [name: string]: number;
}

export interface AgentAttempt {
  attempt_id: string;
  path: string;
  files: AgentAttemptFiles;
}

export interface RawLogResponse {
  agent_id: string;
  attempt_id: string;
  size_bytes: number;
  content: string;
}

export interface AuditEntry {
  timestamp?: number;
  kind?: string;
  event?: string;
  agent_id?: string;
  [k: string]: unknown;
}

export interface ScreenSnapshot {
  timestamp?: number;
  screen?: string;
  [k: string]: unknown;
}

export interface ControllerEntry {
  timestamp?: number;
  request?: Record<string, unknown>;
  response?: ControllerDecision;
  decision?: ControllerDecision;
  [k: string]: unknown;
}

export interface FeedbackEntry {
  timestamp?: number;
  message?: string;
  mode?: FeedbackMode;
  [k: string]: unknown;
}

export interface AgentSummary {
  agent_id?: string;
  role?: string;
  status?: AgentStatus;
  summary?: string;
  started_at?: number;
  finished_at?: number;
  attempt_count?: number;
  [k: string]: unknown;
}

export interface RecordedSession {
  session_id: string;
  path: string;
  manifest: Record<string, unknown>;
  agents: Record<string, AgentAttemptFiles>;
  events_count: number;
  events_file: string;
  handoffs_file: string;
}

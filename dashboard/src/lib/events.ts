// Turns raw orchestrator events into one-line, human-readable timeline entries.
import {
  cliLabel,
  describeDecision,
  isControllerErrorDecision,
  keyLabel,
  roleLabel,
  splitTerminalExcerpt,
  stripAnsi,
  summarizeControllerError,
  truncate,
  type Tone,
} from "./format";
import type { AgentStateResponse, ControllerDecision, Event } from "./types";

export type IconName =
  | "check"
  | "cross"
  | "alert"
  | "play"
  | "stop"
  | "retry"
  | "question"
  | "send"
  | "bot"
  | "flag"
  | "terminal"
  | "dot"
  | "pause";

export interface HumanEvent {
  tone: Tone;
  icon: IconName;
  /** The one-line sentence. */
  text: string;
  /** Optional longer text shown under the sentence. */
  detail?: string;
  /** Routine/noisy events are hidden unless "All events" is selected. */
  routine: boolean;
}

type Data = Record<string, unknown>;

function asData(d: unknown): Data {
  return d && typeof d === "object" && !Array.isArray(d) ? (d as Data) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function quote(text: string, max = 120): string {
  return `“${truncate(text, max)}”`;
}

export function humanizeEvent(
  e: Event,
  agents: Record<string, AgentStateResponse> = {},
): HumanEvent {
  const d = asData(e.data);
  const aid = e.agent_id ?? "";
  const agentRole = aid ? agents[aid]?.role : undefined;
  const who = aid
    ? agentRole
      ? `${roleLabel(agentRole)} agent (${aid})`
      : aid
    : "Orchestrator";
  const stage = roleLabel(str(d.stage) || agentRole);

  switch (e.type) {
    case "heartbeat":
      return { tone: "muted", icon: "dot", text: "Heartbeat", routine: true };

    case "terminal_output": {
      const text = stripAnsi(typeof e.data === "string" ? e.data : str(d.data ?? d.text));
      return {
        tone: "muted",
        icon: "terminal",
        text: `${aid || "Agent"} terminal output`,
        detail: text.trim() ? truncate(text, 400) : undefined,
        routine: true,
      };
    }

    case "llm_decision": {
      const dec = e.data as ControllerDecision | undefined;
      if (isControllerErrorDecision(dec)) {
        return {
          tone: "bad",
          icon: "alert",
          text: `Controller error: ${summarizeControllerError(dec?.reason)}`,
          detail: aid ? `While watching ${aid}. The controller retries automatically.` : undefined,
          routine: false,
        };
      }
      if (!dec || dec.action === "wait") {
        return {
          tone: "muted",
          icon: "bot",
          text: `Controller is letting ${aid || "the agent"} keep working`,
          detail: dec?.reason ? truncate(dec.reason, 240) : undefined,
          routine: true,
        };
      }
      const action = describeDecision(dec);
      const text =
        dec.action === "send_line" || dec.action === "send_text"
          ? `Controller sent ${quote(str(dec.text))} to ${aid || "the agent"}`
          : dec.action === "ask_human"
            ? `Controller asked for human help with ${aid || "the agent"}`
            : `Controller: ${action}${aid ? ` (${aid})` : ""}`;
      return {
        tone: dec.risk === "high" ? "warn" : "info",
        icon: "bot",
        text,
        detail: dec.reason ? truncate(dec.reason, 240) : undefined,
        routine: false,
      };
    }

    case "controller_error":
      return {
        tone: "bad",
        icon: "alert",
        text: `Controller error: ${summarizeControllerError(str(d.reason))}`,
        detail: d.retrying ? "Retrying automatically." : "Not retrying — check the controller configuration.",
        routine: false,
      };

    case "controller_decision_discarded":
      return {
        tone: "muted",
        icon: "bot",
        text: "Controller decision discarded because the screen changed",
        detail: str(d.reason) || undefined,
        routine: true,
      };

    case "agent_started": {
      const role = str(d.role) || agentRole;
      const cli = str(d.cli) || agents[aid]?.agent_cli || (d.devin_model ? "devin" : "");
      const parts = [cliLabel(cli || null)];
      if (d.attempt) parts.push(`attempt ${str(d.attempt)}`);
      if (d.resume) parts.push("resumed");
      const model = str(d.model) || str(d.devin_model);
      const isAux = d.kind === "auxiliary";
      return {
        tone: "info",
        icon: "play",
        text: isAux
          ? `Side task ${aid} started (${parts.join(", ")})`
          : `${roleLabel(role)} agent started (${parts.join(", ")})`,
        detail: model ? `Model: ${model}` : undefined,
        routine: false,
      };
    }

    case "agent_done":
      return {
        tone: "ok",
        icon: "check",
        text: `${stage} ${isGate(str(d.stage) || agentRole) ? "review finished" : "agent finished its work"}`,
        routine: false,
      };

    case "agent_stopped":
      return { tone: "muted", icon: "stop", text: `${who} stopped`, routine: false };

    case "agent_died":
      return {
        tone: "bad",
        icon: "cross",
        text: `${who} crashed${d.retries_exhausted ? " — no retries left" : ""}`,
        routine: false,
      };

    case "agent_retry":
      return {
        tone: "warn",
        icon: "retry",
        text: `Restarting ${aid || "agent"} after a failure${d.retry_count ? ` (retry ${str(d.retry_count)}${d.max ? ` of ${str(d.max)}` : ""})` : ""}`,
        routine: false,
      };

    case "agent_timeout":
      return { tone: "warn", icon: "alert", text: `${who} timed out`, routine: false };

    case "agent_paused":
      return { tone: "muted", icon: "pause", text: `${who} paused`, routine: false };

    case "agent_resumed":
      return { tone: "info", icon: "play", text: `${who} resumed`, routine: false };

    case "critic_approved":
      return { tone: "ok", icon: "check", text: `Critic approved ${stage}`, routine: false };
    case "critic_rejected":
      return {
        tone: "bad",
        icon: "cross",
        text: `Critic rejected ${stage}${d.reason ? ` — ${truncate(str(d.reason), 140)}` : ""}`,
        detail: str(d.reason).length > 140 ? str(d.reason) : undefined,
        routine: false,
      };
    case "reviewer_approved":
      return { tone: "ok", icon: "check", text: `Acceptance reviewer approved ${stage}`, routine: false };
    case "reviewer_rejected":
      return {
        tone: "bad",
        icon: "cross",
        text: `Acceptance reviewer rejected ${stage}${d.reason ? ` — ${truncate(str(d.reason), 140)}` : ""}`,
        detail: str(d.reason).length > 140 ? str(d.reason) : undefined,
        routine: false,
      };

    case "human_approval_needed":
      return {
        tone: "warn",
        icon: "question",
        text: `Asked for your approval${aid ? ` (${aid})` : ""}`,
        detail: splitTerminalExcerpt(str(d.question)).text || undefined,
        routine: false,
      };
    case "human_approval_resolved":
      return {
        tone: d.approved ? "ok" : "warn",
        icon: d.approved ? "check" : "cross",
        text: d.approved ? "You approved the request" : "You denied the request",
        detail: str(d.reason) || undefined,
        routine: false,
      };
    case "human_approval_denied_handled":
      return { tone: "muted", icon: "dot", text: "The agent was told the request was denied", routine: false };

    case "agent_attention":
      return {
        tone: "warn",
        icon: "question",
        text: `${aid || "An agent"} needs your input`,
        detail: splitTerminalExcerpt(str(d.question)).text || undefined,
        routine: false,
      };
    case "agent_question":
      return {
        tone: "warn",
        icon: "question",
        text: `${aid || "An agent"} asked a question`,
        detail: str(d.question) || undefined,
        routine: false,
      };

    case "pipeline_done":
      return { tone: "ok", icon: "flag", text: "Pipeline complete — every stage passed review", routine: false };

    case "handoff_blocked":
      return {
        tone: "warn",
        icon: "alert",
        text: "Handoff to the next stage was blocked",
        detail: str(d.reason) || undefined,
        routine: false,
      };

    case "invalid_stage_marker": {
      const expected = str(d.expected);
      return {
        tone: "warn",
        icon: "alert",
        text: `Ignored verdict “${str(d.marker)}” from ${aid || roleLabel(str(d.stage))}`,
        detail: expected ? `Expected: ${expected}` : "That verdict isn't valid at this step.",
        routine: false,
      };
    }

    case "controller_mark_done_rejected":
      return {
        tone: "warn",
        icon: "alert",
        text: `Controller tried to mark ${aid || "the stage"} done, but it was refused`,
        detail: str(d.reason) || undefined,
        routine: false,
      };
    case "controller_transfer_rejected":
      return {
        tone: "warn",
        icon: "alert",
        text: `Controller's handoff to ${str(d.target) || "another agent"} was refused`,
        detail: str(d.reason) || undefined,
        routine: false,
      };

    case "feedback_injected":
      return { tone: "info", icon: "send", text: `Feedback sent to ${aid || "agent"}: ${quote(str(d.message))}`, routine: false };
    case "feedback_queued":
      return {
        tone: "info",
        icon: "send",
        text: `Guidance saved for ${aid || "agent"}'s next step: ${quote(str(d.message))}`,
        routine: false,
      };
    case "feedback_interrupt":
      return {
        tone: "warn",
        icon: "send",
        text: `Interrupted ${aid || "agent"} and sent: ${quote(str(d.message))}`,
        routine: false,
      };

    case "manual_input": {
      const action = str(d.action);
      let what = action.replace(/_/g, " ");
      if (action === "send_line" || action === "send_text") what = `typed ${quote(str(d.text))}`;
      else if (action === "press_enter") what = "pressed Enter";
      else if (action === "press_key") what = `pressed ${keyLabel(str(d.key))}`;
      else if (action === "send_ctrl_c") what = "pressed Ctrl-C";
      else if (action === "send_escape") what = "pressed Esc";
      return { tone: "info", icon: "send", text: `You ${what} in ${aid || "the terminal"}`, routine: false };
    }

    case "auxiliary_agent_launched":
      return {
        tone: "info",
        icon: "play",
        text: `Side task ${aid} launched (${roleLabel(str(d.role))}${d.cli ? `, ${cliLabel(str(d.cli))}` : ""})`,
        detail: d.model ? `Model: ${str(d.model)}` : undefined,
        routine: false,
      };
    case "auxiliary_agent_done":
      return { tone: "ok", icon: "check", text: `Side task ${aid} finished`, routine: false };

    case "agent_to_agent":
      return {
        tone: "info",
        icon: "send",
        text: `${aid || "An agent"} messaged ${str(d.target ?? d.to_agent ?? d.target_agent) || "another agent"}`,
        detail: str(d.message ?? d.text) || undefined,
        routine: false,
      };

    case "adapter_startup_action":
      return {
        tone: "muted",
        icon: "terminal",
        text: `Startup: ${str(d.description) || "handled a CLI prompt"}`,
        routine: true,
      };
    case "cli_session_captured":
      return {
        tone: "muted",
        icon: "check",
        text: `Saved ${cliLabel(str(d.cli) || null)} session id for ${aid || "agent"} (can resume later)`,
        detail: str(d.session_id) || undefined,
        routine: false,
      };
    case "cli_trace_exported":
      return {
        tone: "muted",
        icon: "check",
        text: `Exported ${cliLabel(str(d.cli) || null)} conversation trace for ${aid || "agent"}`,
        detail: str(d.path) || undefined,
        routine: false,
      };
    case "devin_session_id_recovered":
      return {
        tone: "muted",
        icon: "check",
        text: `Recovered resumable session id for ${aid || "agent"}`,
        detail: str(d.session_id) || undefined,
        routine: true,
      };

    default: {
      const label = e.type.replace(/_/g, " ");
      const detail = e.data == null ? undefined : typeof e.data === "string" ? e.data : JSON.stringify(e.data);
      return {
        tone: "muted",
        icon: "dot",
        text: `${label.charAt(0).toUpperCase()}${label.slice(1)}${aid ? ` (${aid})` : ""}`,
        detail: detail ? truncate(detail, 240) : undefined,
        routine: false,
      };
    }
  }
}

function isGate(role?: string) {
  return role === "critic" || role === "reviewer";
}

/** Key used to collapse identical consecutive events ("×12"). Digits are
 * ignored so "Stuck: 51 idle waits" and "Stuck: 52 idle waits" merge. */
export function collapseKey(e: Event, h: HumanEvent): string {
  return `${e.type}|${e.agent_id ?? ""}|${h.text}|${(h.detail ?? "").replace(/\d+/g, "#")}`;
}

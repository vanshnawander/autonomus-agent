import { useEffect, useRef, useState } from "react";
import { useLiveTerminal } from "@/hooks/useOrchestrator";
import { apiClient } from "@/lib/api";
import type { AgentStateResponse, AgentStatus, FeedbackMode } from "@/lib/types";
import { DecisionView } from "./DecisionView";
import { StatusPill } from "./StatusPill";

const STATUS_DOT: Record<AgentStatus, string> = {
  idle: "bg-faint",
  running: "bg-accent pulse-soft",
  waiting: "bg-warn pulse-soft",
  paused: "bg-warn",
  done: "bg-accent2",
  error: "bg-danger",
  stopped: "bg-faint",
};

const ROLE_CODE: Record<string, string> = {
  "literature-survey": "LS",
  reviewer: "RV",
  critic: "CR",
  methodology: "MT",
  "experiment-executor": "EX",
  "paper-writer": "PW",
};

function roleCode(role: string): string {
  return ROLE_CODE[role] ?? "AG";
}

/** A single agent panel shown inside a tab — terminal + controls + decision. */
function AgentPanel({
  sid,
  aid,
  agent,
  compact = false,
}: {
  sid: string;
  aid: string;
  agent: AgentStateResponse;
  compact?: boolean;
}) {
  const isActive = agent.status === "running" || agent.status === "waiting";
  const live = useLiveTerminal(sid, aid, isActive);
  const screen = live || agent.visible_screen || "";
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState("");
  const [mode, setMode] = useState<FeedbackMode>("context");
  const termRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [screen]);

  const sendInput = async () => {
    if (!input) return;
    try {
      await apiClient.forceInput(sid, aid, { type: "send_line", text: input });
      setInput("");
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const sendKey = async (key: string) => {
    try {
      await apiClient.forceInput(sid, aid, { type: "press_key", key });
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const sendCtrlC = async () => {
    try {
      await apiClient.forceInput(sid, aid, { type: "send_ctrl_c" });
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const sendFeedback = async () => {
    if (!feedback) return;
    try {
      await apiClient.sendFeedback(sid, feedback, aid, mode);
      setFeedback("");
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const restart = async () => {
    if (!confirm(`Restart agent ${aid}? (resume=true)`)) return;
    try {
      await apiClient.restartAgent(sid, aid, true);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Agent header bar */}
      <div className="flex items-center gap-3 px-1">
        <span className="agent-role-code">{roleCode(agent.role)}</span>
        <div className="flex flex-col">
          <span className="font-mono text-sm font-semibold">{aid}</span>
          <span className="text-muted text-[11px]">{agent.role}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {agent.devin_session_id && (
            <span className="text-faint text-[10px] font-mono hidden sm:inline">
              devin: {agent.devin_session_id.slice(0, 12)}…
            </span>
          )}
          <StatusPill status={agent.status} />
          <button
            onClick={restart}
            className="text-[11px] px-2 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent transition-colors"
          >
            ↻ Restart
          </button>
        </div>
      </div>

      {/* Terminal */}
      <div className={`terminal-window ${compact ? "h-56" : "h-80"}`}>
        <div className="terminal-titlebar">
          <span className="terminal-lights" aria-hidden="true"><i /><i /><i /></span>
          <span className="terminal-title">{aid} — devin</span>
          <span className={`terminal-state ${isActive ? "" : "is-idle"}`}>{isActive ? "LIVE" : agent.status.toUpperCase()}</span>
        </div>
        <pre ref={termRef} className="terminal-screen">
          {screen || (
            <span className="text-faint">
              {isActive ? "Connecting to PTY stream…" : "$ agent process is not running\n$ _"}
            </span>
          )}
        </pre>
      </div>

      {/* Input controls — vibrant with focus glow */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-1.5 items-center">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendInput()}
            placeholder="send a line to the agent… (Enter)"
            className="flex-1 bg-ink-950/60 border border-line/60 rounded-xl px-3 py-2 font-mono text-[11px] focus:border-accent focus:outline-none transition-colors"
          />
          <button
            onClick={sendInput}
            className="px-3 py-2 rounded-xl border border-line/60 bg-ink-800/60 text-xs hover:border-accent hover:bg-accent/10 transition-colors"
          >
            Send
          </button>
          <button onClick={() => sendKey("enter")} title="Enter" className="px-2.5 py-2 rounded-xl border border-line/60 bg-ink-800/60 text-xs hover:border-accent transition-colors">⏎</button>
          <button onClick={() => sendKey("escape")} title="Esc" className="px-2.5 py-2 rounded-xl border border-line/60 bg-ink-800/60 text-xs hover:border-accent transition-colors">Esc</button>
          <button onClick={sendCtrlC} title="Ctrl+C" className="px-2.5 py-2 rounded-xl border border-line/60 bg-ink-800/60 text-xs hover:border-danger hover:bg-danger/10 transition-colors">^C</button>
        </div>

        <div className="flex gap-1.5 items-start">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as FeedbackMode)}
            className="bg-ink-950/60 border border-line/60 rounded-xl px-2.5 py-2 text-[11px] w-[110px] focus:outline-none"
          >
            <option value="context">context</option>
            <option value="immediate">immediate</option>
            <option value="interrupt">interrupt</option>
          </select>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Feedback / guidance for this agent…"
            className="flex-1 min-h-[40px] bg-ink-950/60 border border-line/60 rounded-xl px-3 py-2 font-mono text-[11px] resize-y focus:border-accent focus:outline-none transition-colors"
          />
          <button
            onClick={sendFeedback}
            className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-accent to-purple text-white text-xs font-medium hover:shadow-lg hover:shadow-accent/30 transition-all"
          >
            Send
          </button>
        </div>
      </div>

      {/* Approval + decision */}
      {agent.pending_approval && (
        <div className="agent-review-callout">
          <span className="review-alert-dot" />
          <div><strong>Human decision required</strong><span>{agent.pending_approval}</span></div>
        </div>
      )}
      <DecisionView d={agent.last_decision} />
    </div>
  );
}

/** Master-detail agent console with a persistent roster and one focused terminal. */
export function AgentTabs({
  sid,
  agents,
  activeAgent,
}: {
  sid: string;
  agents: Record<string, AgentStateResponse>;
  activeAgent?: string | null;
}) {
  const agentIds = Object.keys(agents);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  // Auto-select the active agent, or the first agent.
  useEffect(() => {
    if (activeTab && agents[activeTab]) return;
    if (activeAgent && agents[activeAgent]) {
      setActiveTab(activeAgent);
    } else if (agentIds.length > 0) {
      setActiveTab(agentIds[0]);
    }
  }, [activeAgent, agentIds, activeTab, agents]);

  if (!agentIds.length) {
    return (
      <div className="card-elevated rounded-2xl p-10 text-center text-muted text-sm">
        <div className="text-4xl mb-3 opacity-20">🤖</div>
        No agents in this session.
      </div>
    );
  }

  const current = activeTab ? agents[activeTab] : null;

  return (
    <div className="agent-console-layout">
      <div className="agent-roster" role="tablist" aria-label="Agents">
        <div className="agent-roster-list">
        {agentIds.map((aid) => {
          const a = agents[aid];
          const isActiveTab = aid === activeTab;
          const isLive = a.status === "running" || a.status === "waiting";
          return (
            <button
              key={aid}
              onClick={() => setActiveTab(aid)}
              role="tab"
              aria-selected={isActiveTab}
              className={`agent-roster-item ${isActiveTab ? "is-selected" : ""}`}
            >
              <span className={`w-2 h-2 rounded-full ${STATUS_DOT[a.status]}`} />
              <span className="agent-role-code">{roleCode(a.role)}</span>
              <span className="agent-roster-copy"><strong>{aid}</strong><small>{a.role}</small></span>
              {isLive && (
                <span className="text-[9px] px-1.5 py-0 rounded-full bg-accent/20 text-accent font-mono font-semibold border border-accent/30">
                  live
                </span>
              )}
              {a.status === "done" && (
                <span className="text-[9px] px-1.5 py-0 rounded-full bg-accent2/20 text-accent2 font-mono font-semibold border border-accent2/30">
                  done
                </span>
              )}
            </button>
          );
        })}
        </div>
      </div>

      <section className="agent-workspace">
        {current && activeTab ? (
          <AgentPanel sid={sid} aid={activeTab} agent={current} />
        ) : (
          <div className="text-muted text-sm p-8 text-center">Select an agent from the roster.</div>
        )}
      </section>
    </div>
  );
}

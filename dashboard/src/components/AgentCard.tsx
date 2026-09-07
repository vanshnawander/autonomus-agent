import { useState } from "react";
import { useLiveTerminal } from "@/hooks/useOrchestrator";
import { apiClient } from "@/lib/api";
import type { AgentStateResponse, FeedbackMode } from "@/lib/types";
import { DecisionView } from "./DecisionView";
import { StatusPill } from "./StatusPill";
import { Terminal } from "./Terminal";

export function AgentCard({
  sid,
  aid,
  agent,
}: {
  sid: string;
  aid: string;
  agent: AgentStateResponse;
}) {
  const isActive = agent.status === "running" || agent.status === "waiting";
  const live = useLiveTerminal(sid, aid, isActive);
  const screen = live || agent.visible_screen || "";
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState("");
  const [mode, setMode] = useState<FeedbackMode>("context");

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
    <div className="bg-ink-900 border border-line rounded-xl overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-line bg-ink-800">
        <span className="font-semibold font-mono">{aid}</span>
        <span className="text-muted text-xs">{agent.role}</span>
        <span className="ml-auto">
          <StatusPill status={agent.status} />
        </span>
      </div>
      <div className="p-3 flex flex-col gap-2">
        <div className="grid grid-cols-[80px_1fr] gap-1 text-xs font-mono">
          <span className="text-muted">devin_id</span>
          <span className="truncate">{agent.devin_session_id ?? "—"}</span>
        </div>
        <Terminal text={screen} className="h-60" />
        <div className="flex gap-1.5 items-center">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendInput()}
            placeholder="type to send line… (Enter)"
            className="flex-1 bg-ink-950 border border-line rounded px-2 py-1 font-mono text-xs"
          />
          <button
            onClick={sendInput}
            className="bg-ink-800 border border-line rounded px-2.5 py-1 text-xs hover:border-accent"
          >
            Send
          </button>
          <button
            onClick={() => sendKey("enter")}
            title="Enter"
            className="bg-ink-800 border border-line rounded px-2 py-1 text-xs hover:border-accent"
          >
            ⏎
          </button>
          <button
            onClick={() => sendKey("escape")}
            title="Esc"
            className="bg-ink-800 border border-line rounded px-2 py-1 text-xs hover:border-accent"
          >
            Esc
          </button>
          <button
            onClick={sendCtrlC}
            title="Ctrl+C"
            className="bg-ink-800 border border-line rounded px-2 py-1 text-xs hover:border-danger"
          >
            ^C
          </button>
          <button
            onClick={restart}
            className="bg-ink-800 border border-line rounded px-2.5 py-1 text-xs hover:border-accent"
          >
            Restart
          </button>
        </div>
        <div className="flex gap-1.5 items-start">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as FeedbackMode)}
            className="bg-ink-950 border border-line rounded px-2 py-1 text-xs w-[110px]"
          >
            <option value="context">context</option>
            <option value="immediate">immediate</option>
            <option value="interrupt">interrupt</option>
          </select>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Feedback / guidance for this agent…"
            className="flex-1 min-h-[40px] bg-ink-950 border border-line rounded px-2 py-1 font-mono text-xs resize-y"
          />
          <button
            onClick={sendFeedback}
            className="bg-accent text-white border border-accent rounded px-3 py-1 text-xs hover:opacity-90"
          >
            Send
          </button>
        </div>
        {agent.pending_approval && (
          <div className="mt-1 px-2 py-1.5 bg-warn/10 border border-warn rounded text-xs">
            <span className="font-semibold">Approval:</span> {agent.pending_approval}
          </div>
        )}
        <DecisionView d={agent.last_decision} />
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { Event } from "@/lib/types";

function fmtTs(t?: number): string {
  if (!t) return "";
  return new Date(t * 1000).toLocaleTimeString([], { hour12: false });
}

const TYPE_COLOR: Record<string, string> = {
  heartbeat: "text-faint",
  agent_started: "text-accent",
  agent_done: "text-accent2",
  agent_error: "text-danger",
  handoff: "text-accent2",
  human_approval_requested: "text-warn",
  human_approval_resolved: "text-accent2",
  human_feedback: "text-warn",
  stage_advanced: "text-purple",
};

/** A live, terminal-style log pane that renders events as colored log lines. */
export function LiveLogTerminal({
  events,
  className = "",
  emptyHint = "waiting for events…",
  showSession = false,
}: {
  events: Event[];
  className?: string;
  emptyHint?: string;
  showSession?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return events;
    return events.filter(
      (e) =>
        e.type.toLowerCase().includes(f) ||
        (e.agent_id ?? "").toLowerCase().includes(f) ||
        (e.session_id ?? "").toLowerCase().includes(f) ||
        JSON.stringify(e.data ?? "").toLowerCase().includes(f),
    );
  }, [events, filter]);

  useEffect(() => {
    if (paused) return;
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [filtered, paused]);

  return (
    <div className={`terminal-window flex flex-col ${className}`}>
      <div className="terminal-titlebar">
        <span className="terminal-lights" aria-hidden="true"><i /><i /><i /></span>
        <span className="terminal-title">orchestrator — event stream</span>
        <span className={`terminal-state ${paused ? "is-paused" : ""}`}>
          {paused ? "PAUSED" : "LIVE"}
        </span>
        <span className="text-xs text-faint font-mono">{filtered.length} lines</span>
        <div className="ml-auto flex items-center gap-1.5">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            className="bg-ink-950/60 border border-line/60 rounded-lg px-2 py-1 font-mono text-xs w-28 focus:border-accent focus:outline-none transition-colors"
          />
          <button
            onClick={() => setPaused((p) => !p)}
            className={`px-2.5 py-1 rounded-lg border text-xs font-mono transition-colors ${
              paused
                ? "text-warn border-warn/40 bg-warn/10"
                : "text-accent2 border-accent2/40 bg-accent2/10 hover:bg-accent2/20"
            }`}
            title={paused ? "Resume auto-scroll" : "Pause auto-scroll"}
          >
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>
      <div
        ref={ref}
        className="terminal-log-screen flex-1 overflow-y-auto p-3 font-mono text-xs leading-[1.55] text-[#c8d0e0]"
      >
        {filtered.length === 0 ? (
          <div className="text-faint">{emptyHint}</div>
        ) : (
          filtered.map((e, i) => {
            const color = TYPE_COLOR[e.type] ?? "text-[#c8d0e0]";
            if (e.type === "heartbeat") {
              return (
                <div key={i} className="text-faint/40">
                  {fmtTs(e.timestamp)} — heartbeat
                </div>
              );
            }
            return (
              <div key={i} className="flex gap-2 py-0.5 hover:bg-accent/5 rounded px-1.5 -mx-1.5 transition-colors">
                <span className="text-faint shrink-0 w-[68px]">
                  {fmtTs(e.timestamp)}
                </span>
                {showSession && (
                  <span className="text-accent2/70 shrink-0 w-[100px] truncate">
                    {e.session_id}
                  </span>
                )}
                {e.agent_id && (
                  <span className="text-purple/80 shrink-0 w-[80px] truncate">
                    {e.agent_id}
                  </span>
                )}
                <span className={`shrink-0 font-semibold ${color}`}>{e.type}</span>
                <span className="text-fg-dim/70 break-words min-w-0">
                  {typeof e.data === "string"
                    ? e.data
                    : e.data
                      ? JSON.stringify(e.data)
                      : ""}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

import type { SessionSummary } from "@/lib/types";

function fmtRelative(ts?: number | null): string {
  if (!ts) return "—";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function SessionList({
  sessions,
  currentSid,
  onSelect,
}: {
  sessions: SessionSummary[];
  currentSid: string | null;
  onSelect: (sid: string) => void;
}) {
  if (!sessions.length) {
    return (
      <div className="text-muted text-xs px-2 py-8 text-center">
        <div className="text-3xl mb-3 opacity-30">📋</div>
        <div className="text-fg-dim">no sessions yet</div>
        <div className="mt-1 text-xs text-faint">
          use "+ New Session" to start
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {sessions.map((s) => {
        const isActive = s.session_id === currentSid;
        const stateLabel = s.live
          ? s.done
            ? "done"
            : s.active_agent
              ? "active"
              : "idle"
          : "recorded";
        const stateCls = s.live
          ? s.done
            ? "text-accent2 border-accent2/40 bg-accent2/10"
            : s.active_agent
              ? "text-accent border-accent/40 bg-accent/10"
              : "text-muted border-line"
          : "text-faint border-line";
        return (
          <button
            key={s.session_id}
            onClick={() => onSelect(s.session_id)}
            className={`text-left p-3 rounded-xl border transition-all lift ${
              isActive
                ? "bg-ink-800/60 border-accent/50 glow-accent"
                : "border-line/40 hover:bg-ink-800/40 hover:border-accent/30"
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  s.live
                    ? s.done
                      ? "bg-accent2"
                      : "bg-accent pulse-soft"
                    : "bg-faint"
                }`}
              />
              <span className="font-mono text-xs truncate flex-1 font-medium">
                {s.session_id}
              </span>
            </div>
            <div className="text-fg-dim text-xs truncate mt-1.5 line-clamp-2 leading-snug">
              {s.goal || "(no goal recorded)"}
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2 text-xs">
              <span className={`px-1.5 py-0.5 rounded border ${stateCls}`}>
                {stateLabel}
              </span>
              {s.agent_count > 0 && (
                <span className="px-1.5 py-0.5 rounded border border-line/60 text-muted">
                  {s.agent_count} ag
                </span>
              )}
              {s.events_count > 0 && (
                <span className="px-1.5 py-0.5 rounded border border-line/60 text-muted">
                  {s.events_count} ev
                </span>
              )}
            </div>
            <div className="text-faint text-xs mt-1.5 font-mono">
              {fmtRelative(s.last_event_at ?? s.created_at)}
            </div>
          </button>
        );
      })}
    </div>
  );
}

import type { AgentStatus } from "@/lib/types";

const STATUS_STYLES: Record<AgentStatus, string> = {
  idle: "bg-ink-700/40 text-muted border-line/60",
  running: "bg-accent/15 text-accent border-accent/40 shadow-[0_0_8px_var(--color-accent-glow)]",
  waiting: "bg-warn/15 text-warn border-warn/40 shadow-[0_0_8px_var(--color-warn-glow)]",
  paused: "bg-warn/15 text-warn border-warn/40",
  done: "bg-accent2/15 text-accent2 border-accent2/40 shadow-[0_0_8px_var(--color-accent2-glow)]",
  error: "bg-danger/15 text-danger border-danger/40 shadow-[0_0_8px_var(--color-danger-glow)]",
  stopped: "bg-ink-700/40 text-muted border-line/60",
};

export function StatusPill({ status }: { status: AgentStatus }) {
  return (
    <span
      className={`text-xs uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLES[status] ?? STATUS_STYLES.idle}`}
    >
      {status}
    </span>
  );
}

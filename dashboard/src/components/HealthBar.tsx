import type { HealthResponse } from "@/lib/types";

export function HealthBar({
  health,
  online,
}: {
  health: HealthResponse | null;
  online: boolean;
}) {
  return (
    <div className="flex items-center gap-2 font-mono text-[11px] px-3 py-1.5 rounded-lg bg-ink-950/40 border border-line/60">
      <span
        className={`w-2 h-2 rounded-full ${
          online ? "bg-accent2 pulse-soft" : "bg-danger"
        }`}
      />
      <span className="text-muted">
        {online ? (
          <>
            <span className="text-accent2">{health?.llm_model ?? "?"}</span>
            <span className="text-faint mx-1.5">·</span>
            <span className="text-purple">devin={health?.devin_model ?? "?"}</span>
            <span className="text-faint mx-1.5">·</span>
            <span className="text-fg-dim">{health?.sessions ?? 0} session(s)</span>
          </>
        ) : (
          <span className="text-danger">server offline</span>
        )}
      </span>
    </div>
  );
}

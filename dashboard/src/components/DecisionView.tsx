import type { ControllerDecision } from "@/lib/types";

const RISK_COLOR: Record<string, string> = {
  low: "text-accent2",
  medium: "text-warn",
  high: "text-danger",
  unknown: "text-muted",
};

export function DecisionView({ d }: { d: ControllerDecision | null | undefined }) {
  if (!d) return null;
  return (
    <div className="mt-1 pt-3 border-t border-line-soft font-mono text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-muted">
          state <span className="text-fg">{d.state}</span>
        </span>
        <span className="text-muted">
          action <span className="text-accent">{d.action}</span>
        </span>
        <span className="text-muted">
          risk <span className={RISK_COLOR[d.risk] ?? "text-muted"}>{d.risk}</span>
        </span>
        <span className="text-muted">
          conf <span className="text-fg">{(d.confidence ?? 0).toFixed(2)}</span>
        </span>
      </div>
      {d.reason && <div className="text-fg-dim mt-1.5">{d.reason}</div>}
      {d.text && (
        <div className="text-fg-dim mt-1">
          <span className="text-muted">text:</span> {d.text}
        </div>
      )}
    </div>
  );
}

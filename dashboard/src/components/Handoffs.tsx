import type { HandoffRecord } from "@/lib/types";

function fmtTs(t: number): string {
  if (!t) return "";
  return new Date(t * 1000).toLocaleTimeString([], { hour12: false });
}

export function Handoffs({ items }: { items: HandoffRecord[] }) {
  if (!items.length) {
    return <div className="text-muted text-xs p-3 text-center">no handoffs yet</div>;
  }
  return (
    <div className="font-mono text-xs">
      {items.map((h, i) => (
        <div key={i} className="py-2 border-b border-line/30 last:border-0">
          <div className="flex items-center gap-2">
            <span className="text-accent font-semibold">{h.from_agent}</span>
            <span className="text-faint">→</span>
            <span className="text-accent2 font-semibold">{h.to_agent}</span>
            <span className="text-faint ml-auto">{fmtTs(h.timestamp)}</span>
          </div>
          {h.reason && <div className="text-fg-dim mt-1.5 leading-snug">{h.reason}</div>}
        </div>
      ))}
    </div>
  );
}

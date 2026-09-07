import { useState } from "react";
import type { ApprovalItem } from "@/lib/types";

const RISK_STYLES: Record<string, string> = {
  high: "bg-danger/20 text-danger border-danger/40",
  medium: "bg-warn/20 text-warn border-warn/40",
  low: "bg-accent2/20 text-accent2 border-accent2/40",
  unknown: "bg-ink-700/60 text-muted border-line/60",
};

export function Approvals({
  items,
  onResolve,
}: {
  items: ApprovalItem[];
  onResolve: (id: string, approved: boolean, reason: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="review-queue overflow-hidden flex flex-col" role="region" aria-label="Human review queue">
      <div className="review-queue-header">
        <span className="review-alert-dot" />
        <div>
          <span className="review-eyebrow">Action required</span>
          <h2>Human review queue</h2>
        </div>
        <span className="text-xs px-2 py-0.5 rounded-full border border-warn/40 text-warn bg-warn/10 font-mono font-semibold">
          {items.length}
        </span>
      </div>
      <div className="p-4 flex flex-col gap-3">
        {items.map((a) => (
          <ApprovalRow key={a.id} item={a} onResolve={onResolve} />
        ))}
      </div>
    </div>
  );
}

function ApprovalRow({
  item,
  onResolve,
}: {
  item: ApprovalItem;
  onResolve: (id: string, approved: boolean, reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <article className="review-request">
      <div className="review-request-topline">
        <span>Decision requested by <strong>{item.agent_id}</strong></span>
        <span className="font-mono">{item.id}</span>
      </div>
      <div className="review-question">
        {item.question}
        <span
          className={`text-xs px-1.5 py-0.5 rounded-full border ${RISK_STYLES[item.risk] ?? RISK_STYLES.unknown}`}
        >
          {item.risk}
        </span>
      </div>
      {item.decision?.reason && <p className="review-context">{item.decision.reason}</p>}
      <div className="review-actions">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reason (optional)"
          className="flex-1 bg-ink-950/60 border border-line/60 rounded-xl px-3 py-2 font-mono text-xs focus:border-accent focus:outline-none transition-colors"
        />
        <button
          onClick={() => onResolve(item.id, true, reason)}
          className="bg-accent2/15 text-accent2 border border-accent2/40 rounded-xl px-3.5 py-2 text-xs font-medium hover:bg-accent2/25 transition-colors"
        >
          Approve request
        </button>
        <button
          onClick={() => onResolve(item.id, false, reason)}
          className="bg-danger/15 text-danger border border-danger/40 rounded-xl px-3.5 py-2 text-xs font-medium hover:bg-danger/25 transition-colors"
        >
          Reject
        </button>
      </div>
    </article>
  );
}

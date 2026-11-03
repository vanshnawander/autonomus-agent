import { useMemo, useState } from "react";
import { collapseKey, humanizeEvent, type HumanEvent } from "@/lib/events";
import { fmtDateTime, fmtTime } from "@/lib/format";
import type { AgentStateResponse, Event } from "@/lib/types";
import { Icon } from "./ui";

type View = "key" | "all" | "raw";

interface Row {
  e: Event;
  h: HumanEvent;
  count: number;
  firstTs: number;
}

const PAGE = 150;

function when(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? fmtTime(ts) : fmtDateTime(ts);
}

/** Humanized, newest-first event feed. Routine noise hidden by default. */
export function ActivityTimeline({
  events,
  agents,
  status,
}: {
  events: Event[];
  agents: Record<string, AgentStateResponse>;
  status?: string;
}) {
  const [view, setView] = useState<View>("key");
  const [agentFilter, setAgentFilter] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const agentIds = useMemo(
    () => Array.from(new Set(events.map((e) => e.agent_id).filter((x): x is string => !!x))).sort(),
    [events],
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const e of events) {
      if (e.type === "heartbeat") continue;
      if (agentFilter && e.agent_id !== agentFilter) continue;
      const h = humanizeEvent(e, agents);
      if (view === "key" && h.routine) continue;
      const prev = out[out.length - 1];
      if (view !== "raw" && prev && collapseKey(prev.e, prev.h) === collapseKey(e, h)) {
        prev.count += 1;
        prev.e = e;
        prev.h = h;
        continue;
      }
      out.push({ e, h, count: 1, firstTs: e.timestamp });
    }
    return out.reverse();
  }, [events, agents, view, agentFilter]);

  const hiddenCount = useMemo(
    () => (view === "key" ? events.filter((e) => e.type !== "heartbeat" && humanizeEvent(e, agents).routine).length : 0),
    [events, agents, view],
  );

  return (
    <div className="timeline">
      <div className="toolbar">
        <div className="filter-group" role="group" aria-label="Which events to show">
          {(
            [
              ["key", "Key events"],
              ["all", "Everything"],
              ["raw", "Raw JSON"],
            ] as [View, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              className={`filter-btn ${view === v ? "is-active" : ""}`}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="select-field">
          <span className="sr-only">Filter by agent</span>
          <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
            <option value="">All agents</option>
            {agentIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        {status && <span className="muted small timeline-status">{status}</span>}
      </div>
      {view === "key" && hiddenCount > 0 && (
        <p className="hint">
          Hiding {hiddenCount} routine events (terminal output, “keep working” checks). Choose “Everything” to see them.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="muted timeline-empty">No activity recorded yet.</p>
      ) : (
        <ol className={`timeline-list ${view === "raw" ? "is-raw" : ""}`}>
          {rows.slice(0, limit).map((row, i) =>
            view === "raw" ? (
              <li key={`${row.e.event_id ?? i}-${i}`} className="tl-raw">
                <span className="tl-time">{when(row.e.timestamp)}</span>
                <code>{JSON.stringify(row.e)}</code>
              </li>
            ) : (
              <li key={`${row.e.event_id ?? i}-${i}`} className={`tl-item tone-${row.h.tone}`}>
                <span className="tl-icon" aria-hidden="true">
                  <Icon name={row.h.icon} />
                </span>
                <div className="tl-body">
                  <div className="tl-text">
                    {row.h.text}
                    {row.count > 1 && (
                      <span className="tl-count" title={`Repeated ${row.count} times since ${when(row.firstTs)}`}>
                        ×{row.count}
                      </span>
                    )}
                  </div>
                  {row.h.detail && <div className="tl-detail">{row.h.detail}</div>}
                </div>
                <time className="tl-time" dateTime={new Date(row.e.timestamp * 1000).toISOString()}>
                  {when(row.e.timestamp)}
                </time>
              </li>
            ),
          )}
        </ol>
      )}
      {rows.length > limit && (
        <button className="btn btn-sm btn-ghost show-more" onClick={() => setLimit((l) => l + PAGE)}>
          Show older ({rows.length - limit} more)
        </button>
      )}
    </div>
  );
}

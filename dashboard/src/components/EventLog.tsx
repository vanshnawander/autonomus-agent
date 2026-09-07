import type { Event } from "@/lib/types";

function fmtTs(t: number): string {
  if (!t) return "";
  return new Date(t * 1000).toLocaleTimeString([], { hour12: false });
}

export function EventLog({ events }: { events: Event[] }) {
  if (!events.length) {
    return <div className="text-muted text-xs p-2">no events yet</div>;
  }
  return (
    <div className="font-mono text-xs max-h-[320px] overflow-y-auto">
      {events.map((e, i) => (
        <div key={i} className="flex gap-2 py-0.5 border-b border-line/40">
          <span className="text-muted shrink-0 w-[70px]">{fmtTs(e.timestamp)}</span>
          <span className="text-accent shrink-0 w-[160px]">{e.type}</span>
          <span className="break-words">
            {typeof e.data === "string" ? e.data : JSON.stringify(e.data)}
          </span>
        </div>
      ))}
    </div>
  );
}

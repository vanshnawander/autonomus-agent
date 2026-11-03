import { fmtRelative, RUN_STATUS_LABEL, RUN_STATUS_TONE, runStatusOf, stageProgressText } from "@/lib/format";
import type { SessionSummary } from "@/lib/types";

/** Compact run list used in the sidebar. Status chips match the home page. */
export function SessionList({
  sessions,
  currentSid,
  onSelect,
  approvalSessions,
}: {
  sessions: SessionSummary[];
  currentSid: string | null;
  onSelect: (sid: string) => void;
  approvalSessions: Set<string>;
}) {
  if (!sessions.length) {
    return (
      <div className="sidebar-empty">
        <strong>No runs yet</strong>
        <span>Use “New run” to start one.</span>
      </div>
    );
  }
  return (
    <ul className="side-runs">
      {sessions.map((s) => {
        const status = runStatusOf(s, approvalSessions);
        const isCurrent = s.session_id === currentSid;
        return (
          <li key={s.session_id}>
            <button
              onClick={() => onSelect(s.session_id)}
              className={`side-run ${isCurrent ? "is-current" : ""}`}
              aria-current={isCurrent ? "page" : undefined}
            >
              <span className="side-run-top">
                <span
                  className={`status-dot tone-${RUN_STATUS_TONE[status]}`}
                  title={RUN_STATUS_LABEL[status]}
                  aria-label={RUN_STATUS_LABEL[status]}
                />
                <span className="side-run-id">{s.session_id}</span>
              </span>
              <span className="side-run-stage">
                {RUN_STATUS_LABEL[status]} · {stageProgressText(s)} · {fmtRelative(s.last_event_at ?? s.created_at)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

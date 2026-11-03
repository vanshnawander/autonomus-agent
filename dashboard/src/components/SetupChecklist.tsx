import { useState } from "react";
import { checkRows } from "@/lib/checks";
import type { PreflightResponse } from "@/lib/types";
import { Icon, Spinner } from "./ui";

/** Setup readiness list. Collapses to one line when everything required passes. */
export function SetupChecklist({
  preflight,
  error,
  defaultCli,
  onRetry,
  collapsible = true,
}: {
  preflight: PreflightResponse | null | undefined;
  error?: string | null;
  defaultCli: string;
  onRetry?: () => void;
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (error && !preflight) {
    return (
      <div className="checklist">
        <div className="checklist-summary tone-bad">
          <Icon name="alert" />
          <span>Couldn't run setup checks: {error}</span>
          {onRetry && (
            <button className="btn btn-sm" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!preflight) return <Spinner label="Checking setup…" />;

  const rows = checkRows(preflight, defaultCli);
  const failed = rows.filter((r) => !r.ok && !r.optional);
  const allOk = failed.length === 0;
  const showList = !collapsible || !allOk || expanded;
  const visible = allOk || !collapsible ? rows : [...failed, ...rows.filter((r) => r.ok || r.optional)];

  return (
    <div className="checklist">
      <div className={`checklist-summary ${allOk ? "tone-ok" : "tone-warn"}`}>
        <Icon name={allOk ? "check" : "alert"} />
        <span>
          {allOk
            ? `Setup ready — ${rows.filter((r) => r.ok).length} checks passed`
            : `${failed.length} setup ${failed.length === 1 ? "problem" : "problems"} to fix before starting a run`}
        </span>
        {collapsible && allOk && (
          <button className="btn btn-sm btn-ghost" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            {expanded ? "Hide details" : "Show details"}
          </button>
        )}
        {onRetry && (
          <button className="btn btn-sm btn-ghost" onClick={onRetry}>
            Re-check
          </button>
        )}
      </div>
      {showList && (
        <ul className="checklist-items">
          {visible.map((row) => (
            <li key={row.name} className={row.ok ? "is-ok" : row.optional ? "is-optional" : "is-failed"}>
              <span className={`check-icon ${row.ok ? "tone-ok" : row.optional ? "tone-muted" : "tone-bad"}`}>
                <Icon name={row.ok ? "check" : row.optional ? "dot" : "cross"} />
              </span>
              <div className="check-body">
                <div className="check-line">
                  <strong>{row.label}</strong>
                  {row.optional && !row.ok && <span className="check-optional">optional · not installed</span>}
                  <code className="check-detail">{row.detail}</code>
                </div>
                {!row.ok && !row.optional && <div className="check-hint">Fix: {row.hint}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

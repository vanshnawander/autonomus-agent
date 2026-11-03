import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CliCard } from "@/components/AgentClis";
import { SetupChecklist } from "@/components/SetupChecklist";
import { Chip, CliBadge, Empty, Icon, Notice, Panel, StatusChip } from "@/components/ui";
import { useAgentClis, usePreflight } from "@/hooks/useOrchestrator";
import { useAppData } from "@/lib/appContext";
import { resolveClis } from "@/lib/clis";
import { fmtDateTime, fmtRelative, RUN_STATUS_LABEL, runStatusOf, stageProgressText } from "@/lib/format";
import { PRESETS } from "@/lib/presets";
import type { RunStatus } from "@/lib/types";

const FILTERS: (RunStatus | "all")[] = ["all", "needs_attention", "running", "stopped", "done", "error"];

export function HomePage() {
  const { health, online, sessions, sessionsError, approvalSessions, openWizard } = useAppData();
  const preflight = usePreflight();
  const agentClis = useAgentClis();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RunStatus | "all">("all");
  const [showClis, setShowClis] = useState(false);

  const resolved = resolveClis(agentClis.data, preflight.data, health);
  const installedClis = resolved.clis.filter((c) => c.installed);

  const rows = useMemo(
    () => sessions.map((s) => ({ s, status: runStatusOf(s, approvalSessions) })),
    [sessions, approvalSessions],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);
  const visible = rows.filter(({ s, status }) => {
    if (filter !== "all" && status !== filter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      s.session_id.toLowerCase().includes(q) ||
      (s.goal ?? "").toLowerCase().includes(q) ||
      (s.agent_cli ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Research runs</h1>
          <p className="page-lead">
            Each run takes a research goal through survey, methodology, experiments and paper writing. Every stage is
            checked by a critic and an acceptance reviewer before the next one starts.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => openWizard()}>
          <Icon name="plus" /> New run
        </button>
      </header>

      {!online && (
        <Notice tone="bad" title="The orchestrator API is offline">
          Start it from the repository root, then this page refreshes on its own:
          <code className="block-code">
            conda run --no-capture-output -n research-agents python -m uvicorn orchestrator.app:app --port 8765
          </code>
        </Notice>
      )}

      <Panel title="Setup" subtitle="What the server needs before a run can start.">
        <SetupChecklist
          preflight={preflight.data}
          error={preflight.error}
          defaultCli={resolved.defaultCli}
          onRetry={preflight.refresh}
        />
        <div className="cli-summary">
          <span className="cli-summary-label">Agent CLIs</span>
          <div className="cli-summary-chips">
            {resolved.clis.map((cli) => (
              <Chip key={cli.name} tone={cli.installed ? "ok" : "muted"} title={cli.installed ? "Installed" : "Not installed"}>
                {cli.display_name}
                {cli.name === resolved.defaultCli ? " (default)" : ""}
                {!cli.installed ? " — not installed" : ""}
              </Chip>
            ))}
          </div>
          <button className="btn btn-sm btn-ghost" onClick={() => setShowClis((v) => !v)} aria-expanded={showClis}>
            {showClis ? "Hide details" : "Compare CLIs"}
          </button>
        </div>
        {resolved.legacy && agentClis.data === null && (
          <p className="hint">This server doesn't report agent CLIs yet; showing what /health and /preflight expose.</p>
        )}
        {showClis && (
          <div className="cli-grid">
            {resolved.clis.map((cli) => (
              <CliCard key={cli.name} cli={cli} isDefault={cli.name === resolved.defaultCli} />
            ))}
          </div>
        )}
        {online && installedClis.length === 0 && preflight.data && (
          <p className="hint tone-text-bad">No agent CLI is installed — runs can't start until one is.</p>
        )}
      </Panel>

      <Panel
        title="Runs"
        subtitle={`${rows.length} total · newest activity first`}
        right={sessionsError ? <span className="tone-text-bad small">{sessionsError}</span> : null}
      >
        <div className="toolbar">
          <label className="search-field">
            <Icon name="search" />
            <span className="sr-only">Search runs</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by run id, goal or CLI"
            />
          </label>
          <div className="filter-group" role="group" aria-label="Filter by status">
            {FILTERS.map((f) => (
              <button
                key={f}
                className={`filter-btn ${filter === f ? "is-active" : ""}`}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All" : RUN_STATUS_LABEL[f]}
                <span className="filter-count">{counts[f] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        {rows.length === 0 ? (
          <Empty>
            <strong>No runs yet.</strong>
            <span>Start one with “New run”, or pick a template below.</span>
          </Empty>
        ) : visible.length === 0 ? (
          <Empty>No runs match this search or filter.</Empty>
        ) : (
          <ul className="run-list">
            {visible.map(({ s, status }) => (
              <li key={s.session_id}>
                <Link to={`/sessions/${s.session_id}`} className={`run-row status-${status}`}>
                  <span className="run-status">
                    <StatusChip status={status} />
                  </span>
                  <span className="run-main">
                    <span className="run-id">{s.session_id}</span>
                    <span className="run-goal">{s.goal || "No goal recorded"}</span>
                  </span>
                  <span className="run-stage">{stageProgressText(s)}</span>
                  <span className="run-cli">
                    <CliBadge cli={s.agent_cli} />
                  </span>
                  <span className="run-time" title={fmtDateTime(s.last_event_at ?? s.created_at)}>
                    {fmtRelative(s.last_event_at ?? s.created_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Start from a template" subtitle="Every field can be edited in the next step.">
        <div className="template-grid">
          {PRESETS.map((preset) => (
            <button key={preset.id} onClick={() => openWizard(preset.id)} className="template-card">
              <strong>{preset.label}</strong>
              <span>{preset.description}</span>
              <small>{preset.agents.length} agents</small>
            </button>
          ))}
        </div>
      </Panel>
    </div>
  );
}

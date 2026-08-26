import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LiveLogTerminal } from "@/components/LiveLogTerminal";
import { NewSessionModal } from "@/components/NewSessionModal";
import { PRESETS } from "@/lib/presets";
import { useAllSessions, useGlobalEvents, useHealth } from "@/hooks/useOrchestrator";

function fmtRelative(ts?: number | null): string {
  if (!ts) return "No events";
  const diff = Math.max(0, Date.now() / 1000 - ts);
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function sessionState(session: {
  live: boolean;
  done: boolean;
  active_agent?: string | null;
}): { label: string; className: string } {
  if (!session.live) return { label: "Recorded", className: "state-recorded" };
  if (session.done) return { label: "Complete", className: "state-complete" };
  if (session.active_agent) return { label: "Running", className: "state-running" };
  return { label: "Idle", className: "state-idle" };
}

export function HomePage() {
  const { health, online } = useHealth();
  const { sessions, error } = useAllSessions();
  const events = useGlobalEvents();
  const [showModal, setShowModal] = useState(false);
  const [presetId, setPresetId] = useState<string | undefined>(undefined);
  const navigate = useNavigate();

  const liveCount = sessions.filter((session) => session.live).length;
  const runningCount = sessions.filter(
    (session) => session.live && !!session.active_agent && !session.done,
  ).length;
  const pendingCount = sessions.filter(
    (session) => session.live && !session.done && !session.active_agent,
  ).length;
  const totalEvents = sessions.reduce((sum, session) => sum + session.events_count, 0);

  const openWizard = (selectedPreset?: string) => {
    setPresetId(selectedPreset);
    setShowModal(true);
  };

  return (
    <div className="workbench-page">
      <section className="workbench-heading">
        <div>
          <div className="section-label">Research operations</div>
          <h1>Command center</h1>
          <p>Monitor autonomous research, intervene when needed, and keep every run accountable.</p>
        </div>
        <button onClick={() => openWizard()} className="primary-button">
          + New session
        </button>
      </section>

      <section className="status-strip" aria-label="Orchestrator status">
        <StatusMetric label="API" value={online ? "Online" : "Offline"} state={online} />
        <StatusMetric
          label="Controller"
          value={health?.llm_configured ? health.llm_model : "Not configured"}
          state={!!health?.llm_configured}
        />
        <StatusMetric
          label="Devin"
          value={health?.devin_model ?? "Unavailable"}
          state={online}
        />
        <StatusMetric label="Running" value={String(runningCount)} state={runningCount > 0} />
        <StatusMetric label="Waiting" value={String(pendingCount)} state={pendingCount === 0} />
        <StatusMetric label="Events" value={String(totalEvents)} state />
      </section>

      {!online && (
        <section className="notice notice-error">
          <div>
            <strong>Orchestrator API is offline.</strong>
            <div className="mt-1 text-[11px]">
              Start it from the configured Conda environment, then refresh this page.
            </div>
          </div>
          <code>conda run -n research-agents python -m uvicorn orchestrator.app:app --port 8765</code>
        </section>
      )}

      <section className="workbench-section">
        <div className="section-heading">
          <div>
            <h2>Sessions</h2>
            <span>{liveCount} live, {sessions.length - liveCount} recorded</span>
          </div>
          {error && <span className="text-danger text-[11px]">{error}</span>}
        </div>

        {sessions.length === 0 ? (
          <div className="empty-state">
            <strong>No research sessions</strong>
            <span>Create a session from a template or define a custom pipeline.</span>
            <button onClick={() => openWizard()} className="secondary-button">
              Create session
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto border border-line rounded-lg">
            <table className="workbench-table session-table min-w-[760px]">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Status</th>
                  <th>Active agent</th>
                  <th>Agents</th>
                  <th>Events</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => {
                  const state = sessionState(session);
                  return (
                    <tr key={session.session_id}>
                      <td data-label="Session" className="max-w-[360px]">
                        <Link
                          to={`/sessions/${session.session_id}`}
                          className="font-mono text-xs font-semibold text-accent hover:underline"
                        >
                          {session.session_id}
                        </Link>
                        <div className="text-[11px] text-muted mt-1 line-clamp-2">
                          {session.goal || "No goal recorded"}
                        </div>
                      </td>
                      <td data-label="Status">
                        <span className={`state-label ${state.className}`}>
                          {state.label}
                        </span>
                      </td>
                      <td data-label="Active agent" className="font-mono text-[11px]">
                        {session.active_agent ?? "-"}
                      </td>
                      <td data-label="Agents">{session.agent_count}</td>
                      <td data-label="Events">{session.events_count}</td>
                      <td data-label="Updated" className="text-muted text-[11px]">
                        {fmtRelative(session.last_event_at ?? session.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="workbench-section">
        <div className="section-heading">
          <div>
            <h2>Session templates</h2>
            <span>Review and edit every field before execution</span>
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => openWizard(preset.id)}
              className="template-row"
            >
              <span className="font-semibold text-sm">{preset.label}</span>
              <span className="text-muted text-[11px] leading-relaxed mt-1.5">
                {preset.description}
              </span>
              <span className="text-[10px] font-mono text-fg-dim mt-3">
                {preset.agents.length} agents
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="workbench-section">
        <div className="section-heading">
          <div>
            <h2>Orchestrator activity</h2>
            <span>Live session events</span>
          </div>
        </div>
        <LiveLogTerminal
          events={events}
          className="h-80"
          showSession
          emptyHint={
            online
              ? "Connected. New session events appear here."
              : "Start the orchestrator to receive events."
          }
        />
      </section>

      {showModal && (
        <NewSessionModal
          initialPresetId={presetId}
          onClose={() => setShowModal(false)}
          onCreated={(sessionId) => navigate(`/sessions/${sessionId}`)}
        />
      )}
    </div>
  );
}

function StatusMetric({
  label,
  value,
  state,
}: {
  label: string;
  value: string;
  state: boolean;
}) {
  return (
    <div className="status-metric">
      <span className={`status-dot ${state ? "status-ok" : "status-error"}`} />
      <div>
        <div className="text-[10px] uppercase text-muted">{label}</div>
        <div className="text-xs font-mono truncate" title={value}>
          {value}
        </div>
      </div>
    </div>
  );
}

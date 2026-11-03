import { useMemo, useState } from "react";
import {
  HashRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { NewRunWizard } from "@/components/NewRunWizard";
import { SessionList } from "@/components/SessionList";
import { Icon } from "@/components/ui";
import { AgentDetailPage } from "@/pages/AgentDetailPage";
import { HomePage } from "@/pages/HomePage";
import { SessionOverviewPage } from "@/pages/SessionOverviewPage";
import { useAllSessions, useHealth, usePendingApprovals } from "@/hooks/useOrchestrator";
import { runStatusOf, summarizeControllerError } from "@/lib/format";
import { AppContext } from "@/lib/appContext";

function RedirectToSession() {
  const { sid } = useParams<{ sid: string }>();
  return <Navigate to={sid ? `/sessions/${sid}` : "/"} replace />;
}

function Shell() {
  const { health, online } = useHealth();
  const { sessions, error: sessionsError } = useAllSessions();
  const { approvals } = usePendingApprovals(sessions);
  const [wizard, setWizard] = useState<{ open: boolean; presetId?: string }>({ open: false });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const currentSid = location.pathname.match(/^\/sessions\/([^/]+)/)?.[1] ?? null;
  // Home already lists every run, so the sidebar only appears inside a run.
  const showSidebar = currentSid !== null;
  const approvalSessions = useMemo(() => new Set(approvals.map((a) => a.session_id)), [approvals]);
  const needsYou = sessions.filter((s) => runStatusOf(s, approvalSessions) === "needs_attention");
  const controllerError = health?.controller_error;

  const selectSession = (sid: string) => {
    setSidebarOpen(false);
    navigate(`/sessions/${sid}`);
  };

  const openWizard = (presetId?: string) => setWizard({ open: true, presetId });

  const appData = { health, online, sessions, sessionsError, approvals, approvalSessions, openWizard };

  return (
    <AppContext.Provider value={appData}>
      <div className={`app-shell ${showSidebar ? "" : "no-sidebar"}`}>
        <header className="app-header">
          {showSidebar && (
            <button
              onClick={() => setSidebarOpen((open) => !open)}
              className="btn btn-ghost btn-icon menu-button"
              aria-label="Show runs"
              aria-expanded={sidebarOpen}
            >
              <Icon name="menu" />
            </button>
          )}
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Icon name="flag" />
            </span>
            <span className="brand-name">Research Control</span>
          </Link>
          <div className="header-spacer" />
          <span
            className={`api-pill ${online ? (controllerError ? "tone-warn" : "tone-ok") : "tone-bad"}`}
            title={
              online
                ? controllerError
                  ? `Controller error: ${controllerError}`
                  : `Controller model: ${health?.llm_model ?? "unknown"}`
                : "Cannot reach the orchestrator API"
            }
            role="status"
          >
            <span className="chip-dot" aria-hidden="true" />
            {online ? (controllerError ? "Controller error" : "API online") : "API offline"}
          </span>
          {needsYou.length > 0 && (
            <button
              className="btn btn-warn needs-you-button"
              onClick={() => navigate(`/sessions/${needsYou[0].session_id}`)}
              title={`Runs waiting on you: ${needsYou.map((s) => s.session_id).join(", ")}`}
            >
              <span className="pulse-dot" aria-hidden="true" />
              Needs you ({needsYou.length})
            </button>
          )}
          {location.pathname !== "/" && (
            <button onClick={() => openWizard()} className="btn btn-primary new-run-button">
              <Icon name="plus" />
              <span>New run</span>
            </button>
          )}
        </header>

        {showSidebar && (
        <aside className={`app-sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="Runs">
          <div className="sidebar-head">
            <h2>Runs</h2>
            <span className="sidebar-count">{sessions.length}</span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="btn btn-ghost btn-icon sidebar-close"
              aria-label="Close runs list"
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="sidebar-scroll">
            <SessionList
              sessions={sessions}
              currentSid={currentSid}
              onSelect={selectSession}
              approvalSessions={approvalSessions}
            />
          </div>
          {online && controllerError && (
            <div className="sidebar-foot tone-warn">
              <strong>Controller error</strong>
              <span>{summarizeControllerError(controllerError)}</span>
            </div>
          )}
          {!online && (
            <div className="sidebar-foot tone-bad">
              <strong>API offline</strong>
              <span>Start the orchestrator:</span>
              <code>python -m uvicorn orchestrator.app:app --port 8765</code>
            </div>
          )}
        </aside>
        )}

        {showSidebar && sidebarOpen && (
          <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close runs list" />
        )}

        <main className="app-main" id="main">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/sessions/:sid" element={<SessionOverviewPage />} />
            <Route path="/sessions/:sid/agents/:aid" element={<AgentDetailPage />} />
            <Route path="/sessions/:sid/reviewer" element={<RedirectToSession />} />
            <Route path="/sessions/:sid/quality" element={<RedirectToSession />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>

        {wizard.open && (
          <NewRunWizard
            initialPresetId={wizard.presetId}
            onClose={() => setWizard({ open: false })}
            onCreated={(sid) => navigate(`/sessions/${sid}`)}
          />
        )}
      </div>
    </AppContext.Provider>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}

import { useState } from "react";
import {
  HashRouter,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { HealthBar } from "@/components/HealthBar";
import { NewSessionModal } from "@/components/NewSessionModal";
import { PageTransition } from "@/components/PageTransition";
import { SessionList } from "@/components/SessionList";
import { AgentDetailPage } from "@/pages/AgentDetailPage";
import { HomePage } from "@/pages/HomePage";
import { ReviewerPage } from "@/pages/ReviewerPage";
import { SessionOverviewPage } from "@/pages/SessionOverviewPage";
import { useAllSessions, useHealth, usePendingApprovals } from "@/hooks/useOrchestrator";

function Shell() {
  const { health, online } = useHealth();
  const { sessions } = useAllSessions();
  const { approvals } = usePendingApprovals(sessions);
  const [showModal, setShowModal] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const liveCount = sessions.filter((session) => session.live && !session.done).length;
  const currentSid = location.pathname.match(/^\/sessions\/([^/]+)/)?.[1] ?? null;

  const selectSession = (sid: string) => {
    setSidebarOpen(false);
    navigate(`/sessions/${sid}`);
  };

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <header className="app-header">
        <button
          onClick={() => {
            if (window.matchMedia("(max-width: 820px)").matches) {
              setSidebarOpen((open) => !open);
            } else {
              setSidebarCollapsed((collapsed) => !collapsed);
            }
          }}
          className="icon-button mobile-menu-button"
          aria-label="Toggle session navigation"
          aria-expanded={sidebarOpen || !sidebarCollapsed}
          title={sidebarCollapsed ? "Show sessions" : "Hide sessions"}
        >
          <span className="menu-glyph" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>
        <Link to="/" className="app-brand">
          <span className="app-mark" aria-hidden="true"><span /></span>
          <span className="brand-copy">
            <strong>Research Control</strong>
            <small>Evidence operations</small>
          </span>
        </Link>
        <div className="header-health">
          <HealthBar health={health} online={online} />
        </div>
        {approvals.length > 0 && (
          <button
            onClick={() => navigate(`/sessions/${approvals[0].session_id}#review-queue`)}
            className="review-alert-button"
          >
            <span className="review-alert-dot" />
            Human review
            <strong>{approvals.length}</strong>
          </button>
        )}
        <button onClick={() => setShowModal(true)} className="primary-button">
          New session
        </button>
      </header>

      <aside className={`app-sidebar ${sidebarOpen ? "app-sidebar-open" : ""}`}>
        <div className="sidebar-heading">
          <div>
            <span className="section-kicker">Workspace</span>
            <h2>Sessions</h2>
          </div>
          <span>{liveCount > 0 ? `${liveCount} live` : `${sessions.length} total`}</span>
          <button
            onClick={() => setSidebarOpen(false)}
            className="icon-button sidebar-close"
            aria-label="Close session navigation"
            title="Close"
          >
            x
          </button>
        </div>
        {approvals.length > 0 && (
          <button
            className="sidebar-review-alert"
            onClick={() => selectSession(approvals[0].session_id)}
          >
            <span>Review queue</span>
            <strong>{approvals.length}</strong>
            <small>Agent work is waiting on you</small>
          </button>
        )}
        <div className="sidebar-list">
          <SessionList
            sessions={sessions}
            currentSid={currentSid}
            onSelect={selectSession}
          />
        </div>
        {!online && (
          <div className="sidebar-offline">
            <strong>API offline</strong>
            <code>conda run -n research-agents python -m uvicorn orchestrator.app:app --port 8765</code>
          </div>
        )}
      </aside>

      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <main className={`app-main ${approvals.length > 0 ? "has-review-request" : ""}`}>
        {approvals.length > 0 && (
          <div className="global-review-banner" role="status">
            <div>
              <span className="review-alert-dot" />
              <strong>{approvals.length} human {approvals.length === 1 ? "decision" : "decisions"} required</strong>
              <span>{approvals[0].agent_id} is waiting in {approvals[0].session_id}</span>
            </div>
            <button onClick={() => navigate(`/sessions/${approvals[0].session_id}#review-queue`)}>
              Review now
            </button>
          </div>
        )}
        <PageTransition>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/sessions/:sid" element={<SessionOverviewPage />} />
            <Route path="/sessions/:sid/agents/:aid" element={<AgentDetailPage />} />
            <Route path="/sessions/:sid/reviewer" element={<ReviewerPage />} />
            <Route path="/sessions/:sid/quality" element={<ReviewerPage />} />
          </Routes>
        </PageTransition>
      </main>

      {showModal && (
        <NewSessionModal
          onClose={() => setShowModal(false)}
          onCreated={(sid) => navigate(`/sessions/${sid}`)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}

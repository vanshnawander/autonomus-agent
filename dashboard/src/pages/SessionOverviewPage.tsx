import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AgentTabs } from "@/components/AgentTabs";
import { Approvals } from "@/components/Approvals";
import { Handoffs } from "@/components/Handoffs";
import { LiveLogTerminal } from "@/components/LiveLogTerminal";
import { Breadcrumbs, ErrorBox, Spinner } from "@/components/ui";
import {
  useRecordedEvents,
  useSession,
  useSessionEvents,
} from "@/hooks/useOrchestrator";
import { apiClient } from "@/lib/api";
import type { ApprovalItem, Event, HandoffRecord } from "@/lib/types";

export function SessionOverviewPage() {
  const { sid } = useParams<{ sid: string }>();
  if (!sid) return <ErrorBox msg="missing sid" />;
  return <SessionOverviewInner sid={sid} />;
}

function SessionOverviewInner({ sid }: { sid: string }) {
  const { session, error } = useSession(sid);
  const liveEvents = useSessionEvents(sid);
  const { data: recordedEvents } = useRecordedEvents(sid, 200);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);
  const [resuming, setResuming] = useState(false);

  const events: Event[] = liveEvents.length ? liveEvents : recordedEvents ?? [];
  const isRecorded = session?.live === false;

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const items = await apiClient.listApprovals(sid);
        if (alive) setApprovals(items);
      } catch {
        /* ignore */
      }
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [sid]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const hs = await apiClient.listHandoffs(sid);
        if (alive) setHandoffs(hs);
      } catch {
        /* ignore */
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [sid]);

  if (error) return <ErrorBox msg={error} />;
  if (!session) return <Spinner label="loading session…" />;

  const agents = session.agents ?? {};
  const hasReviewer = Object.values(agents).some((a) => a.role === "reviewer");
  const agentCount = Object.keys(agents).length;

  const handleResolve = async (id: string, approved: boolean, reason: string) => {
    try {
      await apiClient.resolveApproval(sid, id, approved, reason);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const handleResume = async () => {
    setResuming(true);
    try {
      await apiClient.resumeSession(sid, true);
      window.location.reload();
    } catch (e) {
      alert((e as Error).message);
      setResuming(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Stop and delete session ${sid}?`)) return;
    try {
      await apiClient.deleteSession(sid);
      window.location.href = "/";
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div className="session-page">
      <Breadcrumbs items={[{ label: "sessions", to: "/" }, { label: sid }]} />

      <div className="session-command-header">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-[280px]">
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${
                  session.active_agent ? "bg-accent pulse-soft" : session.done ? "bg-accent2" : "bg-faint"
                }`}
              />
              <span className="text-muted text-[11px] uppercase tracking-wider font-mono">
                {isRecorded ? "recorded session" : session.done ? "completed" : session.active_agent ? "running" : "idle"}
              </span>
            </div>
            <div className="text-[15px] mt-2 leading-relaxed">{session.goal}</div>
          </div>
          <div className="flex items-center gap-2">
            {hasReviewer && (
              <Link
                to={`/sessions/${sid}/reviewer`}
                className="bg-accent2/10 text-accent2 border border-accent2/40 rounded-xl px-3 py-1.5 text-xs hover:bg-accent2/20 transition-colors flex items-center gap-1.5"
              >
                Reviewer gates
              </Link>
            )}
            {isRecorded && !session.done && (
              <button
                onClick={handleResume}
                disabled={resuming}
                className="primary-button disabled:opacity-40"
              >
                {resuming ? "Resuming..." : "Resume session"}
              </button>
            )}
            <button
              onClick={handleDelete}
              className="bg-danger/10 text-danger border border-danger/40 rounded-xl px-3 py-1.5 text-xs hover:bg-danger/20 transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
      </div>

      {approvals.length > 0 && (
        <section id="review-queue">
          <Approvals items={approvals} onResolve={handleResolve} />
        </section>
      )}

      <section className="session-section">
        <div className="session-section-heading">
          <div><span className="section-kicker">Live execution</span><h2>Agent console</h2></div>
          <span>{agentCount} agents</span>
        </div>
        <AgentTabs sid={sid} agents={agents} activeAgent={session.active_agent} />
      </section>

      <div className="session-lower-grid">
        <section className="session-section">
          <div className="session-section-heading">
            <div><span className="section-kicker">Telemetry</span><h2>Event stream</h2></div>
            <span>{events.length} events</span>
          </div>
          <LiveLogTerminal
            events={events}
            className="h-[420px]"
            emptyHint={isRecorded ? "Showing recorded events from disk." : "Connected. Events will stream here as the pipeline runs."}
          />
        </section>

        <section className="session-section">
          <div className="session-section-heading">
            <div><span className="section-kicker">Coordination</span><h2>Agent handoffs</h2></div>
            <span>{handoffs.length} records</span>
          </div>
          <div className="card-elevated p-4 h-[420px] overflow-y-auto">
            {handoffs.length === 0 ? <div className="text-muted text-xs p-4 text-center">No handoffs yet</div> : <Handoffs items={handoffs} />}
          </div>
        </section>
      </div>
    </div>
  );
}

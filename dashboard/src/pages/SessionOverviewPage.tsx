import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AgentTabs } from "@/components/AgentTabs";
import { Approvals } from "@/components/Approvals";
import { Handoffs } from "@/components/Handoffs";
import { LiveLogTerminal } from "@/components/LiveLogTerminal";
import { PipelineView } from "@/components/PipelineView";
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
  const { events: liveEvents, connection: eventConnection } = useSessionEvents(sid);
  const { data: recordedEvents } = useRecordedEvents(sid, 200);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);
  const [resuming, setResuming] = useState(false);
  const [auxOpen, setAuxOpen] = useState(false);
  const [auxId, setAuxId] = useState("");
  const [auxRole, setAuxRole] = useState("methodology");
  const [auxModel, setAuxModel] = useState("");
  const [auxPrompt, setAuxPrompt] = useState("");
  const [auxBusy, setAuxBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

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
  const hasQualityGate = Object.values(agents).some((a) => a.role === "reviewer" || a.role === "critic");
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

  const handleLaunchAux = async () => {
    if (!auxId.trim() || !auxPrompt.trim() || auxBusy) return;
    setAuxBusy(true);
    setOperationError(null);
    try {
      await apiClient.launchAuxiliary(sid, {
        agent_id: auxId.trim(), role: auxRole, prompt: auxPrompt.trim(),
        model: auxModel.trim() || null,
      });
      setAuxId(""); setAuxPrompt(""); setAuxOpen(false);
    } catch (e) {
      setOperationError((e as Error).message);
    } finally {
      setAuxBusy(false);
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
              <span className="text-muted text-xs uppercase tracking-wider font-mono">
                {isRecorded ? "recorded session" : session.done ? "completed" : session.active_agent ? "running" : "idle"}
              </span>
            </div>
            <div className="text-[15px] mt-2 leading-relaxed">{session.goal}</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setAuxOpen((value) => !value)} className="primary-button">
              {auxOpen ? "Close launcher" : "Launch agent"}
            </button>
            {hasQualityGate && (
              <Link
                to={`/sessions/${sid}/quality`}
                className="bg-accent2/10 text-accent2 border border-accent2/40 rounded-xl px-3 py-1.5 text-xs hover:bg-accent2/20 transition-colors flex items-center gap-1.5"
              >
                Quality gates
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

      <section className="session-section pipeline-panel">
        <div className="session-section-heading">
          <div><span className="section-kicker">Research protocol</span><h2>Stage progression</h2></div>
          <span>{Math.min((session.stage_index ?? 0) + 1, session.pipeline?.length ?? 0)} / {session.pipeline?.length ?? 0}</span>
        </div>
        <PipelineView
          agents={agents}
          activeAgent={session.active_agent}
          pipeline={session.pipeline}
          stageIndex={session.stage_index}
        />
      </section>

      {operationError && <ErrorBox msg={operationError} />}
      {auxOpen && (
        <section className="card-elevated p-4">
          <div className="session-section-heading"><div><span className="section-kicker">Supervision</span><h2>Launch auxiliary agent</h2></div></div>
          <div className="grid gap-3 md:grid-cols-3">
            <input value={auxId} onChange={(e) => setAuxId(e.target.value)} placeholder="agent id" className="bg-ink-950/60 border border-line rounded-xl px-3 py-2" />
            <select value={auxRole} onChange={(e) => setAuxRole(e.target.value)} className="bg-ink-950/60 border border-line rounded-xl px-3 py-2">
              <option value="literature-survey">Literature survey</option><option value="critic">Critic</option><option value="reviewer">Reviewer</option><option value="methodology">Methodology</option><option value="experiment-executor">Experiment executor</option><option value="paper-writer">Paper writer</option>
            </select>
            <input value={auxModel} onChange={(e) => setAuxModel(e.target.value)} placeholder="model (server default)" className="bg-ink-950/60 border border-line rounded-xl px-3 py-2" />
          </div>
          <textarea value={auxPrompt} onChange={(e) => setAuxPrompt(e.target.value)} placeholder="Concrete task and completion criteria" className="mt-3 w-full min-h-28 bg-ink-950/60 border border-line rounded-xl px-3 py-2" />
          <button disabled={auxBusy || !auxId.trim() || !auxPrompt.trim()} onClick={handleLaunchAux} className="primary-button mt-3 disabled:opacity-40">{auxBusy ? "Launching…" : "Launch managed agent"}</button>
        </section>
      )}

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
            <span>{events.length} events · {eventConnection}</span>
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

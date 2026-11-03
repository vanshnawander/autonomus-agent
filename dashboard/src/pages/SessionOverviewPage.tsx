import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ActionNeeded } from "@/components/ActionNeeded";
import { ActivityTimeline } from "@/components/ActivityTimeline";
import { AgentList } from "@/components/AgentList";
import { AgentConsole } from "@/components/AgentConsole";
import { PipelineStepper } from "@/components/PipelineStepper";
import { SideTaskForm } from "@/components/SideTaskForm";
import { Breadcrumbs, Chip, CliBadge, ErrorBox, Icon, Panel, Spinner } from "@/components/ui";
import {
  useAgentClis,
  useApprovals,
  useHandoffs,
  useRecordedEvents,
  useSession,
  useSessionEvents,
} from "@/hooks/useOrchestrator";
import { apiClient, errorMessage } from "@/lib/api";
import { useAppData } from "@/lib/appContext";
import { resolveClis } from "@/lib/clis";
import {
  cliLabel,
  currentStageOf,
  isControllerErrorDecision,
  roleLabel,
  splitTerminalExcerpt,
  summarizeControllerError,
  truncate,
  type Tone,
} from "@/lib/format";
import { buildPipeline } from "@/lib/pipeline";
import type { AgentStateResponse, ApprovalItem, Event, SessionResponse } from "@/lib/types";

export function SessionOverviewPage() {
  const { sid } = useParams<{ sid: string }>();
  if (!sid) return <ErrorBox msg="Missing run id in the URL." />;
  return <SessionOverviewInner key={sid} sid={sid} />;
}

/** Recorded events from disk, followed by anything newer from the live stream. */
function mergeEvents(recorded: Event[] | null, live: Event[]): Event[] {
  const rec = recorded ?? [];
  if (!live.length) return rec;
  const firstLive = live[0].timestamp;
  const liveIds = new Set(live.map((e) => e.event_id).filter(Boolean));
  const older = rec.filter((e) => e.timestamp < firstLive && !(e.event_id && liveIds.has(e.event_id)));
  return [...older, ...live];
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "terminal", label: "Terminal" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
] as const;
type TabId = (typeof TABS)[number]["id"];

interface Banner {
  tone: Tone;
  icon: "check" | "play" | "pause" | "alert" | "question" | "flag" | "cross";
  headline: string;
  detail?: string;
  primary?: "resume" | "stop" | "review";
}

function bannerFor(
  session: SessionResponse,
  agents: AgentStateResponse[],
  approvals: ApprovalItem[],
  controllerError: string | null,
): Banner {
  const pipeline = session.pipeline ?? [];
  const idx = session.stage_index ?? 0;
  const stage = currentStageOf(session);
  const alive = agents.filter((a) => a.alive);
  const stageAgent = agents.find((a) => a.kind !== "auxiliary" && a.role === stage);
  const waiting = approvals[0]
    ? { aid: approvals[0].agent_id, q: approvals[0].question }
    : (() => {
        const a = agents.find((x) => x.attention);
        return a ? { aid: a.agent_id, q: a.attention ?? "" } : null;
      })();
  const stepText = pipeline.length ? `step ${Math.min(idx + 1, pipeline.length)} of ${pipeline.length}` : "";

  if (session.done) {
    return {
      tone: "ok",
      icon: "flag",
      headline: `Completed — ${pipeline.length ? `all ${pipeline.length} steps` : "every stage"} passed review.`,
      detail: "Nothing is running. Agent pages keep the full logs of every attempt.",
    };
  }
  if (waiting) {
    const n = approvals.length + agents.filter((a) => a.attention).length;
    return {
      tone: "warn",
      icon: "question",
      headline: `${waiting.aid} is waiting for you${n > 1 ? ` (${n} items)` : ""}.`,
      detail: truncate(splitTerminalExcerpt(waiting.q).text, 200),
      primary: "review",
    };
  }
  if (alive.length) {
    const main = alive.find((a) => a.kind !== "auxiliary") ?? alive[0];
    const side = alive.filter((a) => a !== main).length;
    return {
      tone: controllerError ? "warn" : "info",
      icon: "play",
      headline: `Running ${roleLabel(main.kind === "auxiliary" ? main.role : stage ?? main.role)}${
        stepText && main.kind !== "auxiliary" ? ` (${stepText})` : ""
      } — ${main.agent_id} is working in ${cliLabel(main.agent_cli ?? session.agent_cli)}${
        side ? `, plus ${side} side task${side === 1 ? "" : "s"}` : ""
      }.`,
      detail: controllerError
        ? `But the controller is failing: ${summarizeControllerError(controllerError)}. See “Action needed”.`
        : "The controller watches the terminal and answers routine prompts. You only need to act if something appears under “Action needed”.",
      primary: "stop",
    };
  }
  if (stageAgent?.status === "error") {
    return {
      tone: "bad",
      icon: "cross",
      headline: `Stopped after an error in ${roleLabel(stage)}${stepText ? ` (${stepText})` : ""}.`,
      detail: "Check the agent's terminal and activity below, then resume to retry this stage.",
      primary: "resume",
    };
  }
  return {
    tone: "muted",
    icon: "pause",
    headline: `Stopped at ${roleLabel(stage)}${stepText ? ` (${stepText})` : ""}. Nothing is running.`,
    detail: `Resume restarts the ${roleLabel(stage).toLowerCase()} agent${
      stageAgent ? ` (${stageAgent.agent_id})` : ""
    } and continues where it left off; its previous conversation is reused when the CLI supports it.`,
    primary: "resume",
  };
}

function SessionOverviewInner({ sid }: { sid: string }) {
  const navigate = useNavigate();
  const { health } = useAppData();
  const { session, error, refresh } = useSession(sid);
  const { events: liveEvents, connection } = useSessionEvents(sid);
  const recorded = useRecordedEvents(sid, 500);
  const approvalsQ = useApprovals(sid);
  const handoffsQ = useHandoffs(sid);
  const agentClis = useAgentClis();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<"resume" | "stop" | "delete" | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [showGoal, setShowGoal] = useState(false);
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: TabId = TABS.some((t) => t.id === tabParam) ? (tabParam as TabId) : "overview";
  const setTab = (next: TabId) =>
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      if (next === "overview") out.delete("tab");
      else out.set("tab", next);
      return out;
    }, { replace: true });

  const events = useMemo(() => mergeEvents(recorded.data, liveEvents), [recorded.data, liveEvents]);
  const agentsMap = useMemo(() => session?.agents ?? {}, [session]);
  const groups = useMemo(
    () =>
      buildPipeline({
        pipeline: session?.pipeline,
        stageIndex: session?.stage_index,
        done: session?.done,
        agents: agentsMap,
        handoffs: handoffsQ.data ?? [],
        events,
      }),
    [session, agentsMap, handoffsQ.data, events],
  );

  if (error && !session) return <ErrorBox msg={`Couldn't load run ${sid}: ${error}`} />;
  if (!session) return <Spinner label="Loading run…" />;

  const agents = Object.values(agentsMap);
  const approvals = approvalsQ.data ?? [];
  const alive = agents.filter((a) => a.alive);
  const stage = currentStageOf(session);
  const stageAgent = agents.find((a) => a.kind !== "auxiliary" && a.role === stage) ?? null;
  const controllerError =
    session.controller_error ??
    (alive.length
      ? (health?.controller_error ??
        alive.find((a) => isControllerErrorDecision(a.last_decision))?.last_decision?.reason ??
        null)
      : null);
  const banner = bannerFor(session, agents, approvals, controllerError);
  const clis = resolveClis(agentClis.data, null, health);
  const sessionCli = session.agent_cli ?? health?.default_agent_cli ?? null;

  // Terminal focus: explicit choice, else the live pipeline agent, else whoever needs attention, else the stage agent.
  const pipelineAgents = agents.filter((a) => a.kind !== "auxiliary");
  const sideAgents = agents.filter((a) => a.kind === "auxiliary");
  const focusId =
    (selected && agentsMap[selected] ? selected : null) ??
    (session.active_agent && agentsMap[session.active_agent]?.alive ? session.active_agent : null) ??
    alive.find((a) => a.kind !== "auxiliary")?.agent_id ??
    alive[0]?.agent_id ??
    agents.find((a) => a.attention)?.agent_id ??
    stageAgent?.agent_id ??
    (session.active_agent && agentsMap[session.active_agent] ? session.active_agent : null) ??
    agents[0]?.agent_id ??
    null;
  const focus = focusId ? agentsMap[focusId] : null;

  const showTerminal = (aid: string) => {
    setSelected(aid);
    setTab("terminal");
  };

  const resume = async () => {
    setBusy("resume");
    setOpError(null);
    try {
      await apiClient.resumeSession(sid, true);
      refresh();
      recorded.refresh();
    } catch (e) {
      setOpError(`Resume failed: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const stopAll = async () => {
    if (!confirm(`Stop ${alive.length} running agent${alive.length === 1 ? "" : "s"}? You can resume the run later.`)) return;
    setBusy("stop");
    setOpError(null);
    try {
      await Promise.all(alive.map((a) => apiClient.stopAgent(sid, a.agent_id)));
      refresh();
    } catch (e) {
      setOpError(`Stop failed: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const deleteRun = async () => {
    if (!confirm(`Stop every agent and remove run ${sid} from the server? Recorded logs on disk are kept.`)) return;
    setBusy("delete");
    try {
      await apiClient.deleteSession(sid);
      navigate("/");
    } catch (e) {
      setOpError(`Delete failed: ${errorMessage(e)}`);
      setBusy(null);
    }
  };

  const goal = session.goal || "No goal recorded.";
  const longGoal = goal.length > 220;

  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Runs", to: "/" }, { label: sid }]} />

      <header className="run-head">
        <h1 className="run-title">{sid}</h1>
        <p className="run-goal-text">
          {longGoal && !showGoal ? truncate(goal, 220) : goal}{" "}
          {longGoal && (
            <button className="link-btn" onClick={() => setShowGoal((v) => !v)} aria-expanded={showGoal}>
              {showGoal ? "Show less" : "Show full goal"}
            </button>
          )}
        </p>
        <div className="run-facts">
          <span>
            Default CLI <CliBadge cli={sessionCli} />
          </span>
          <span>
            Approvals:{" "}
            <strong>{session.approval_mode === "autonomous" ? "Autonomous" : "Manual"}</strong>
          </span>
        </div>
      </header>

      <section className={`banner tone-${banner.tone}`} aria-live="polite">
        <span className="banner-icon" aria-hidden="true">
          <Icon name={banner.icon} />
        </span>
        <div className="banner-body">
          <p className="banner-headline">{banner.headline}</p>
          {banner.detail && <p className="banner-detail">{banner.detail}</p>}
          {opError && <p className="inline-error">{opError}</p>}
        </div>
        <div className="banner-actions">
          {banner.primary === "resume" && (
            <button className="btn btn-primary btn-lg" onClick={resume} disabled={!!busy}>
              <Icon name="play" /> {busy === "resume" ? "Resuming…" : "Resume run"}
            </button>
          )}
          {banner.primary === "review" && (
            <a
              className="btn btn-warn btn-lg"
              href="#action-needed"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById("action-needed")?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              Review now
            </a>
          )}
          {(banner.primary === "stop" || (banner.primary === "review" && alive.length > 0)) && (
            <button className="btn btn-danger" onClick={stopAll} disabled={!!busy}>
              <Icon name="stop" /> {busy === "stop" ? "Stopping…" : "Stop all"}
            </button>
          )}
          {session.done && <Chip tone="ok">Completed</Chip>}
        </div>
      </section>

      <ActionNeeded
        sid={sid}
        approvals={approvals}
        agents={agentsMap}
        controllerError={controllerError}
        onApprovalResolved={() => {
          approvalsQ.refresh();
          refresh();
        }}
        onShowTerminal={showTerminal}
      />

      <nav className="tabs" role="tablist" aria-label="Run sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? "is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "terminal" && alive.length > 0 && <span className="tab-live" aria-label="live" />}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <>
          <Panel title="Pipeline" subtitle="Each stage is checked by a critic, then by an acceptance reviewer.">
            <PipelineStepper groups={groups} />
          </Panel>
          <Panel
            title="Agents"
            subtitle={`${alive.length} running of ${agents.length}${
              sideAgents.length ? ` · includes ${sideAgents.length} side task${sideAgents.length === 1 ? "" : "s"}` : ""
            }`}
          >
            <AgentList
              sid={sid}
              agents={[...pipelineAgents, ...sideAgents]}
              currentStageAgent={session.done ? null : stageAgent?.agent_id}
              onShowTerminal={showTerminal}
            />
          </Panel>
        </>
      )}

      {tab === "terminal" && (
        <Panel
          id="terminal"
          title="Terminal"
          right={
            agents.length > 1 ? (
              <label className="inline-field">
                <span>Agent</span>
                <select value={focusId ?? ""} onChange={(e) => setSelected(e.target.value)}>
                  {agents.map((a) => (
                    <option key={a.agent_id} value={a.agent_id}>
                      {a.agent_id} — {roleLabel(a.role)}
                      {a.alive ? " (running)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : undefined
          }
        >
          {focus ? <AgentConsole key={focus.agent_id} sid={sid} agent={focus} /> : <p className="muted">No agents.</p>}
        </Panel>
      )}

      {tab === "activity" && (
        <Panel title="Activity" subtitle="What happened in this run, newest first.">
          <ActivityTimeline
            events={events}
            agents={agentsMap}
            status={liveEvents.length ? (connection === "connected" ? "Live" : "Reconnecting…") : "From recorded logs"}
          />
        </Panel>
      )}

      {tab === "settings" && (
        <>
          <Panel title="Run details">
            <dl className="facts">
              <dt>Run ID</dt>
              <dd><code>{sid}</code></dd>
              <dt>Default agent CLI</dt>
              <dd><CliBadge cli={sessionCli} /></dd>
              <dt>Approval mode</dt>
              <dd>
                {session.approval_mode === "autonomous"
                  ? "Autonomous — the controller may approve low and medium-risk actions."
                  : "Manual — medium and high-risk actions wait for you."}
              </dd>
              {session.workspace && (
                <>
                  <dt>Workspace</dt>
                  <dd><code>{session.workspace}</code></dd>
                </>
              )}
            </dl>
          </Panel>
          <Panel
            title="Start a side task"
            subtitle="Run an extra agent for a one-off job next to the pipeline. It does not change the pipeline's order."
          >
            <SideTaskForm
              sid={sid}
              clis={clis.clis}
              defaultCli={sessionCli ?? clis.defaultCli}
              onLaunched={(aid) => {
                refresh();
                showTerminal(aid);
              }}
            />
          </Panel>
          <Panel title="Remove run" subtitle="Stops every agent and removes the run from the server. Recorded logs on disk are kept.">
            <button className="btn btn-danger" onClick={deleteRun} disabled={!!busy}>
              Remove run from server…
            </button>
          </Panel>
        </>
      )}
    </div>
  );
}

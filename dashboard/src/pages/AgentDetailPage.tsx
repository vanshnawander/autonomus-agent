import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AgentConsole } from "@/components/AgentConsole";
import { Terminal } from "@/components/Terminal";
import { Breadcrumbs, Chip, CliBadge, Empty, ErrorBox, Icon, Spinner } from "@/components/ui";
import {
  useAgentAttempts,
  useAgentAudit,
  useAgentController,
  useAgentFeedback,
  useAgentRaw,
  useAgentScreens,
  useAgentSummary,
  useSession,
} from "@/hooks/useOrchestrator";
import {
  agentStatusLabel,
  agentStatusTone,
  cliLabel,
  describeDecision,
  fmtBytes,
  fmtDateTime,
  fmtTime,
  isControllerErrorDecision,
  keyLabel,
  roleLabel,
  stripAnsi,
  summarizeControllerError,
} from "@/lib/format";
import type { AgentStateResponse, ControllerDecision, Risk } from "@/lib/types";

type Tab = "overview" | "terminal" | "output" | "replay" | "decisions" | "actions" | "feedback";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "terminal", label: "Terminal" },
  { id: "output", label: "Output" },
  { id: "replay", label: "Replay" },
  { id: "decisions", label: "Decisions" },
  { id: "actions", label: "Keystrokes" },
  { id: "feedback", label: "Feedback" },
];

const RISK_TONE: Record<Risk, "ok" | "warn" | "bad" | "muted"> = { low: "ok", medium: "warn", high: "bad", unknown: "muted" };

export function AgentDetailPage() {
  const { sid, aid } = useParams<{ sid: string; aid: string }>();
  if (!sid || !aid) return <ErrorBox msg="Missing run or agent id in the URL." />;
  return <AgentDetailInner key={`${sid}/${aid}`} sid={sid} aid={aid} />;
}

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn-sm btn-ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function AgentDetailInner({ sid, aid }: { sid: string; aid: string }) {
  const { session, error } = useSession(sid);
  const agent = session?.agents?.[aid];
  const attempts = useAgentAttempts(sid, aid);
  const [attemptId, setAttemptId] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("overview");

  if (error && !session) return <ErrorBox msg={`Couldn't load run ${sid}: ${error}`} />;
  if (!session) return <Spinner label="Loading agent…" />;
  if (!agent) {
    return (
      <div className="page">
        <Breadcrumbs items={[{ label: "Runs", to: "/" }, { label: sid, to: `/sessions/${sid}` }, { label: aid }]} />
        <ErrorBox msg={`Agent ${aid} isn't part of run ${sid}.`} />
      </div>
    );
  }

  const cliSession = agent.cli_session_id ?? agent.devin_session_id ?? null;
  const attemptList = attempts.data ?? [];
  const attemptCount = agent.attempt_count ?? attemptList.length;
  const recordedTab = tab !== "overview" && tab !== "terminal";

  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Runs", to: "/" }, { label: sid, to: `/sessions/${sid}` }, { label: aid }]} />

      <header className="agent-head">
        <div className="agent-head-main">
          <h1>{aid}</h1>
          <div className="agent-head-chips">
            <span className="muted">
              {agent.kind === "auxiliary" ? "Side task · " : ""}
              {roleLabel(agent.role)}
            </span>
            <Chip tone={agentStatusTone(agent)} dot={agent.alive}>
              {agentStatusLabel(agent)}
            </Chip>
            <CliBadge cli={agent.agent_cli ?? session.agent_cli} />
            {agent.model && <span className="agent-model">{agent.model}</span>}
          </div>
        </div>
        <dl className="facts">
          <dt>Resumable {cliLabel(agent.agent_cli ?? session.agent_cli)} session</dt>
          <dd>
            {cliSession ? (
              <>
                <code>{cliSession}</code> <CopyText text={cliSession} />
              </>
            ) : (
              <span className="muted">none captured — a restart begins a fresh conversation</span>
            )}
          </dd>
          <dt>Attempts</dt>
          <dd>{attemptCount || "—"}{(agent.retry_count ?? 0) > 0 ? ` (${agent.retry_count} automatic retries)` : ""}</dd>
          <dt>Started</dt>
          <dd>{agent.started_at ? fmtDateTime(agent.started_at) : "—"}</dd>
          <dt>Finished</dt>
          <dd>{agent.finished_at ? fmtDateTime(agent.finished_at) : "—"}</dd>
        </dl>
      </header>

      <div className="tabs" role="tablist" aria-label="Agent details">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="agent-tabpanel"
            className={`tab ${tab === t.id ? "is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "terminal" && agent.alive && <span className="tab-live" aria-label="live" />}
          </button>
        ))}
      </div>

      {recordedTab && (
        <div className="attempt-bar">
          <label className="select-field">
            <span>Attempt</span>
            <select value={attemptId ?? ""} onChange={(e) => setAttemptId(e.target.value || undefined)}>
              <option value="">Latest attempt</option>
              {attemptList.map((a) => (
                <option key={a.attempt_id} value={a.attempt_id}>
                  Attempt {Number(a.attempt_id)} · {fmtBytes(Object.values(a.files).reduce((x, y) => x + y, 0))}
                </option>
              ))}
            </select>
          </label>
          {attempts.error && <span className="inline-error">{attempts.error}</span>}
        </div>
      )}

      <section className="tabpanel" role="tabpanel" id="agent-tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "overview" && <OverviewTab sid={sid} aid={aid} agent={agent} onOpen={setTab} />}
        {tab === "terminal" && <AgentConsole sid={sid} agent={agent} />}
        {tab === "output" && <OutputTab sid={sid} aid={aid} attemptId={attemptId} />}
        {tab === "replay" && <ReplayTab sid={sid} aid={aid} attemptId={attemptId} />}
        {tab === "decisions" && <DecisionsTab sid={sid} aid={aid} attemptId={attemptId} />}
        {tab === "actions" && <ActionsTab sid={sid} aid={aid} attemptId={attemptId} />}
        {tab === "feedback" && <FeedbackTab sid={sid} aid={aid} attemptId={attemptId} />}
      </section>
    </div>
  );
}

function OverviewTab({
  sid,
  aid,
  agent,
  onOpen,
}: {
  sid: string;
  aid: string;
  agent: AgentStateResponse;
  onOpen: (t: Tab) => void;
}) {
  const summary = useAgentSummary(sid, aid);
  const d = agent.last_decision;
  const notWritten = !!summary.error && /not written|404/i.test(summary.error);
  return (
    <div className="overview-grid">
      {(agent.attention || agent.pending_approval) && (
        <div className="notice tone-warn">
          <Icon name="question" />
          <div className="notice-body">
            <strong>Waiting for you</strong>
            <div className="notice-text">{agent.attention ?? agent.pending_approval}</div>
            <Link to={`/sessions/${sid}`} className="link-btn">
              Answer on the run page
            </Link>
          </div>
        </div>
      )}
      <div className="card">
        <h3>Summary</h3>
        {summary.data?.summary ? (
          <p className="prewrap">{summary.data.summary}</p>
        ) : (
          <p className="muted">
            {notWritten || summary.data
              ? "No summary yet — the agent writes one when it finishes a stage."
              : summary.error
                ? summary.error
                : "Loading…"}
          </p>
        )}
      </div>
      <div className="card">
        <h3>Controller's latest decision</h3>
        {d ? <DecisionLine d={d} /> : <p className="muted">No decision yet.</p>}
        <button className="btn btn-sm btn-ghost" onClick={() => onOpen("decisions")}>
          See all decisions <Icon name="chevron" />
        </button>
      </div>
      <div className="card">
        <h3>Where to look</h3>
        <ul className="plain-list">
          <li>
            <button className="link-btn" onClick={() => onOpen(agent.alive ? "terminal" : "output")}>
              {agent.alive ? "Live terminal" : "Output log"}
            </button>{" "}
            — what the agent is printing.
          </li>
          <li>
            <button className="link-btn" onClick={() => onOpen("replay")}>Screen replay</button> — step through
            recorded screens.
          </li>
          <li>
            <button className="link-btn" onClick={() => onOpen("actions")}>Keystrokes sent</button> — every input the
            controller or a human typed.
          </li>
        </ul>
      </div>
    </div>
  );
}

function DecisionLine({ d }: { d: ControllerDecision }) {
  if (isControllerErrorDecision(d)) {
    return (
      <div className="decision">
        <span className="tone-text-bad">Controller error: {summarizeControllerError(d.reason)}</span>
        <details className="why">
          <summary>Full error</summary>
          <pre className="raw-error">{d.reason}</pre>
        </details>
      </div>
    );
  }
  return (
    <div className="decision">
      <div className="decision-line">
        <strong>{describeDecision(d)}</strong>
        <Chip tone={RISK_TONE[d.risk] ?? "muted"}>{d.risk} risk</Chip>
        <span className="muted small">
          agent looked {d.state.replace(/_/g, " ")} · {Math.round((d.confidence ?? 0) * 100)}% sure
        </span>
      </div>
      {d.text && d.action !== "send_line" && d.action !== "send_text" && <pre className="proposed-text">{d.text}</pre>}
      {d.reason && <p className="decision-reason">{d.reason}</p>}
    </div>
  );
}

function OutputTab({ sid, aid, attemptId }: { sid: string; aid: string; attemptId?: string }) {
  const [size, setSize] = useState(65536);
  const raw = useAgentRaw(sid, aid, attemptId, size);
  if (raw.error) return <ErrorBox msg={raw.error} />;
  if (!raw.data) return <Spinner label="Loading output…" />;
  return (
    <div className="stack">
      <div className="toolbar">
        <span className="muted small">
          Showing the last {fmtBytes(Math.min(size, raw.data.size_bytes))} of {fmtBytes(raw.data.size_bytes)} (terminal
          colour codes removed).
        </span>
        {raw.data.size_bytes > size && (
          <button className="btn btn-sm" onClick={() => setSize((s) => s * 4)}>
            Load more
          </button>
        )}
        <button className="btn btn-sm btn-ghost" onClick={raw.refresh}>
          Refresh
        </button>
      </div>
      <Terminal text={stripAnsi(raw.data.content)} title={`${aid} output log`} className="term-tall" />
    </div>
  );
}

function ReplayTab({ sid, aid, attemptId }: { sid: string; aid: string; attemptId?: string }) {
  const screens = useAgentScreens(sid, aid, 100, attemptId);
  const list = screens.data ?? [];
  const [pos, setPos] = useState<number | null>(null);
  if (screens.error) return <ErrorBox msg={screens.error} />;
  if (!screens.data) return <Spinner label="Loading screens…" />;
  if (!list.length) return <Empty>No screens were recorded for this attempt.</Empty>;
  const idx = Math.min(pos ?? list.length - 1, list.length - 1);
  const snap = list[idx];
  return (
    <div className="stack">
      <div className="toolbar replay-bar">
        <button className="btn btn-sm" onClick={() => setPos(Math.max(0, idx - 1))} disabled={idx === 0}>
          ← Older
        </button>
        <label className="replay-slider">
          <span className="sr-only">Screen number</span>
          <input type="range" min={0} max={list.length - 1} value={idx} onChange={(e) => setPos(Number(e.target.value))} />
        </label>
        <button className="btn btn-sm" onClick={() => setPos(Math.min(list.length - 1, idx + 1))} disabled={idx === list.length - 1}>
          Newer →
        </button>
        <span className="muted small">
          Screen {idx + 1} of {list.length}
          {snap.timestamp ? ` · ${fmtDateTime(snap.timestamp)}` : ""}
        </span>
      </div>
      <Terminal text={stripAnsi(snap.screen ?? "")} title={`${aid} screen`} className="term-tall" autoScroll={false} />
    </div>
  );
}

function DecisionsTab({ sid, aid, attemptId }: { sid: string; aid: string; attemptId?: string }) {
  const [hideWaits, setHideWaits] = useState(true);
  const q = useAgentController(sid, aid, 200, attemptId);
  if (q.error) return <ErrorBox msg={q.error} />;
  if (!q.data) return <Spinner label="Loading decisions…" />;
  const all = [...q.data].reverse();
  const list = hideWaits ? all.filter((c) => c.decision?.action !== "wait" || isControllerErrorDecision(c.decision)) : all;
  return (
    <div className="stack">
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={hideWaits} onChange={(e) => setHideWaits(e.target.checked)} />
          Hide “keep waiting” decisions ({all.length - list.length})
        </label>
        <span className="muted small">Newest first · last 200</span>
      </div>
      {list.length === 0 ? (
        <Empty>No decisions to show.</Empty>
      ) : (
        <ol className="log-list">
          {list.map((c, i) => (
            <li key={i}>
              <time className="log-time">{fmtTime(c.timestamp)}</time>
              {c.decision ? <DecisionLine d={c.decision} /> : <span className="muted">No decision recorded</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  controller: "Controller",
  feedback: "Your feedback",
  human: "You",
  manual: "You",
  human_approval: "Controller, after your approval",
  human_denial: "Dismissed after your denial",
  adapter: "Automatic startup answer",
};

function ActionsTab({ sid, aid, attemptId }: { sid: string; aid: string; attemptId?: string }) {
  const q = useAgentAudit(sid, aid, 400, attemptId);
  if (q.error) return <ErrorBox msg={q.error} />;
  if (!q.data) return <Spinner label="Loading actions…" />;
  const actions = q.data.filter((a) => (a.kind ?? a.event) === "action").reverse();
  if (!actions.length) return <Empty>No keystrokes or input were sent in this attempt.</Empty>;
  return (
    <ol className="log-list">
      {actions.map((a, i) => {
        const action = String(a.action ?? "");
        const text = typeof a.text === "string" ? a.text : null;
        const key = typeof a.key === "string" ? a.key : null;
        const source = SOURCE_LABEL[String(a.source ?? "")] ?? String(a.source ?? "Unknown");
        return (
          <li key={i}>
            <time className="log-time">{fmtTime(a.timestamp)}</time>
            <div>
              <div className="decision-line">
                <strong>
                  {describeDecision({
                    action: action as ControllerDecision["action"],
                    text,
                    key,
                    state: "thinking",
                    confidence: 1,
                    risk: "low",
                    reason: "",
                  })}
                </strong>
                <span className="muted small">by {source}</span>
              </div>
              {text && text.length > 80 && <pre className="proposed-text">{text}</pre>}
              {key && !text && <kbd>{keyLabel(key)}</kbd>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const MODE_LABEL: Record<string, string> = {
  immediate: "Sent now",
  context: "Guidance for next step",
  interrupt: "Interrupted and sent",
};

function FeedbackTab({ sid, aid, attemptId }: { sid: string; aid: string; attemptId?: string }) {
  const q = useAgentFeedback(sid, aid, attemptId);
  if (q.error) return /404|not found/i.test(q.error) ? <Empty>No feedback was sent in this attempt.</Empty> : <ErrorBox msg={q.error} />;
  if (!q.data) return <Spinner label="Loading feedback…" />;
  if (!q.data.length) return <Empty>No feedback was sent in this attempt.</Empty>;
  return (
    <ol className="log-list">
      {[...q.data].reverse().map((f, i) => (
        <li key={i}>
          <time className="log-time">{fmtTime(f.timestamp)}</time>
          <div>
            <Chip tone={f.mode === "interrupt" ? "warn" : "info"}>{MODE_LABEL[f.mode ?? "context"] ?? f.mode}</Chip>
            <p className="prewrap">{f.message}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

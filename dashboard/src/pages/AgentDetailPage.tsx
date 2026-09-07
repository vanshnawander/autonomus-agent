import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { AgentCard } from "@/components/AgentCard";
import { Breadcrumbs, Card, Empty, ErrorBox, Spinner } from "@/components/ui";
import { Terminal } from "@/components/Terminal";
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
import type {
  AgentAttempt,
  AuditEntry,
  ControllerEntry,
  FeedbackEntry,
  ScreenSnapshot,
} from "@/lib/types";

function fmtTs(t?: number): string {
  if (!t) return "";
  return new Date(t * 1000).toLocaleTimeString([], { hour12: false });
}

export function AgentDetailPage() {
  const { sid, aid } = useParams<{ sid: string; aid: string }>();
  if (!sid || !aid) return <ErrorBox msg="missing sid/aid" />;
  return <AgentDetailInner sid={sid} aid={aid} />;
}

function AgentDetailInner({ sid, aid }: { sid: string; aid: string }) {
  const { session } = useSession(sid);
  const agent = session?.agents?.[aid];
  const { data: attempts, error: attemptsErr } = useAgentAttempts(sid, aid);
  const [attemptId, setAttemptId] = useState<string | undefined>(undefined);
  const { data: raw, error: rawErr } = useAgentRaw(sid, aid, attemptId, 32768);
  const { data: audit } = useAgentAudit(sid, aid, 200, attemptId);
  const { data: controller } = useAgentController(sid, aid, 200, attemptId);
  const { data: screens } = useAgentScreens(sid, aid, 100, attemptId);
  const { data: feedback } = useAgentFeedback(sid, aid, attemptId);
  const { data: summary } = useAgentSummary(sid, aid, attemptId);

  const isQualityGate = agent?.role === "reviewer" || agent?.role === "critic";

  return (
    <div className="detail-page">
      <Breadcrumbs
        items={[
          { label: "sessions", to: "/" },
          { label: sid, to: `/sessions/${sid}` },
          { label: "agents", to: `/sessions/${sid}` },
          { label: aid },
        ]}
      />

      <div className="detail-hero">
        <div>
          <span className="section-kicker">Agent workspace</span>
          <h1>{aid}</h1>
        </div>
        <span className="text-muted text-xs">
          role: {agent?.role ?? "—"} · status: {agent?.status ?? "—"}
        </span>
        {isQualityGate && (
          <Link
            to={`/sessions/${sid}/quality`}
            className="quality-link"
          >
            Quality gates →
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3.5">
        {/* Live interactive card */}
        <div className="flex flex-col gap-3.5">
          {agent ? (
            <AgentCard sid={sid} aid={aid} agent={agent} />
          ) : (
            <Card title="Live">
              <Spinner label="loading agent state…" />
            </Card>
          )}

          <Card title="Summary" right={summary?.status ? <StatusBadge status={String(summary.status)} /> : null}>
            {summary ? (
              <div className="text-xs font-mono whitespace-pre-wrap">
                {summary.summary || "(no summary written yet)"}
                <div className="text-muted mt-2">
                  started: {summary.started_at ? fmtTs(summary.started_at) : "—"} ·
                  finished: {summary.finished_at ? fmtTs(summary.finished_at) : "—"} ·
                  attempts: {summary.attempt_count ?? "—"}
                </div>
              </div>
            ) : (
              <Empty>No summary written yet.</Empty>
            )}
          </Card>

          <Card title="Attempts / Invocations">
            {attemptsErr ? (
              <ErrorBox msg={attemptsErr} />
            ) : !attempts || !attempts.length ? (
              <Empty>No recorded invocations.</Empty>
            ) : (
              <div className="flex flex-col gap-1.5">
                {attempts.map((a: AgentAttempt) => (
                  <button
                    key={a.attempt_id}
                    onClick={() => setAttemptId(a.attempt_id)}
                    className={`text-left p-2 rounded border text-xs font-mono ${
                      attemptId === a.attempt_id
                        ? "border-accent bg-ink-800"
                        : "border-line hover:bg-ink-800"
                    }`}
                  >
                    <div className="flex justify-between">
                      <span>attempt {a.attempt_id}</span>
                      <span className="text-muted">
                        {Object.keys(a.files).length} files
                      </span>
                    </div>
                    <div className="text-muted text-xs mt-1 truncate">
                      {Object.keys(a.files).join(", ")}
                    </div>
                  </button>
                ))}
                {attemptId && (
                  <button
                    onClick={() => setAttemptId(undefined)}
                    className="text-left text-xs text-muted hover:text-accent"
                  >
                    ↳ show latest attempt
                  </button>
                )}
              </div>
            )}
          </Card>
        </div>

        {/* Recorded logs */}
        <div className="flex flex-col gap-3.5">
          <Card
            title="Raw PTY Output"
            right={
              <span className="text-xs text-muted">
                {raw ? `${raw.size_bytes} bytes` : ""}
              </span>
            }
          >
            {rawErr ? (
              <ErrorBox msg={rawErr} />
            ) : raw ? (
              <Terminal text={raw.content} className="h-72" />
            ) : (
              <Spinner label="loading raw…" />
            )}
          </Card>

          <Card title="Controller Decisions">
            {!controller || !controller.length ? (
              <Empty>No controller decisions recorded.</Empty>
            ) : (
              <div className="font-mono text-xs max-h-72 overflow-y-auto">
                {controller.map((c: ControllerEntry, i: number) => (
                  <div key={i} className="py-1 border-b border-line/40">
                    <div className="text-muted">{fmtTs(c.timestamp)}</div>
                    {c.decision && (
                      <div>
                        <span className="text-accent">{c.decision.action}</span>{" "}
                        <span className="text-muted">
                          state={c.decision.state} risk={c.decision.risk} conf=
                          {(c.decision.confidence ?? 0).toFixed(2)}
                        </span>
                        <div className="text-muted">{c.decision.reason}</div>
                        {c.decision.text && (
                          <div className="text-muted">text: {c.decision.text}</div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Audit Log">
            {!audit || !audit.length ? (
              <Empty>No audit events.</Empty>
            ) : (
              <div className="font-mono text-xs max-h-72 overflow-y-auto">
                {audit.map((a: AuditEntry, i: number) => (
                  <div key={i} className="py-1 border-b border-line/40">
                    <span className="text-muted">{fmtTs(a.timestamp)}</span>{" "}
                    <span className="text-accent">{String(a.event ?? a.type ?? "?")}</span>
                    <div className="text-muted break-words">
                      {JSON.stringify(
                        Object.fromEntries(
                          Object.entries(a).filter(
                            ([k]) => !["timestamp", "event", "type"].includes(k),
                          ),
                        ) as Record<string, unknown>,
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Feedback">
            {!feedback || !feedback.length ? (
              <Empty>No feedback sent.</Empty>
            ) : (
              <div className="font-mono text-xs max-h-60 overflow-y-auto">
                {feedback.map((f: FeedbackEntry, i: number) => (
                  <div key={i} className="py-1 border-b border-line/40">
                    <span className="text-muted">{fmtTs(f.timestamp)}</span>{" "}
                    <span className="text-warn">[{f.mode ?? "context"}]</span>
                    <div className="break-words">{f.message}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Screen Snapshots">
            {!screens || !screens.length ? (
              <Empty>No screen snapshots recorded.</Empty>
            ) : (
              <div className="flex flex-col gap-2 max-h-80 overflow-y-auto">
                {screens.map((s: ScreenSnapshot, i: number) => (
                  <div key={i} className="border border-line rounded p-2">
                    <div className="text-muted text-xs mb-1">
                      {fmtTs(s.timestamp)}
                    </div>
                    <Terminal text={s.screen ?? ""} className="h-32" />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "done"
      ? "text-accent2 border-accent2"
      : status === "running"
        ? "text-accent border-accent"
        : status === "error"
          ? "text-danger border-danger"
          : "text-muted border-line";
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border ${color}`}>
      {status}
    </span>
  );
}

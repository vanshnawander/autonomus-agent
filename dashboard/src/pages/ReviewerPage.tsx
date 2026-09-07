import { Link, useParams } from "react-router-dom";
import { Breadcrumbs, Card, Empty, ErrorBox, Spinner } from "@/components/ui";
import { Terminal } from "@/components/Terminal";
import {
  useAgentAttempts,
  useAgentAudit,
  useAgentController,
  useAgentRaw,
  useSession,
  useSessionEvents,
} from "@/hooks/useOrchestrator";
import type { AgentStateResponse } from "@/lib/types";

function fmtTs(t?: number): string {
  if (!t) return "";
  return new Date(t * 1000).toLocaleTimeString([], { hour12: false });
}

const VERDICT_RE = /\b(APPROVE|APPROVED|REJECT|REJECTED|REVISE|REQUEST_REVISION)\b/i;

export function ReviewerPage() {
  const { sid } = useParams<{ sid: string }>();
  if (!sid) return <ErrorBox msg="missing sid" />;
  return <ReviewerInner sid={sid} />;
}

function ReviewerInner({ sid }: { sid: string }) {
  const { session, error } = useSession(sid);
  const { events } = useSessionEvents(sid);

  if (error) return <ErrorBox msg={error} />;
  if (!session) return <Spinner label="loading session…" />;

  const agents = session.agents ?? {};
  const reviewers = Object.entries(agents).filter(
    ([, agent]) => agent.role === "critic" || agent.role === "reviewer",
  );
  const workAgents = Object.entries(agents).filter(([, agent]) => !["critic", "reviewer"].includes(agent.role));

  // Find review-related events (verdicts, handoffs).
  const reviewEvents = events.filter(
    (e) =>
      e.type.includes("review") ||
      e.type.includes("critic") ||
      e.type.includes("verdict") ||
      e.type.includes("handoff") ||
      e.type.includes("approval") ||
      e.type.includes("gate"),
  );

  // Extract verdicts from reviewer agent screens / recent output.
  const verdicts = reviewers.map(([aid, a]) => ({
    aid,
    agent: a,
    verdict: extractVerdict(a.visible_screen + "\n" + a.recent_output),
  }));

  return (
    <div className="detail-page">
      <Breadcrumbs
        items={[
          { label: "sessions", to: "/" },
          { label: sid, to: `/sessions/${sid}` },
          { label: "quality" },
        ]}
      />

      <div className="detail-hero quality-hero">
        <div>
          <span className="section-kicker">Independent review</span>
          <h1>Quality gates</h1>
        </div>
        <span className="text-muted text-xs">
          {reviewers.length} critic/reviewer agent(s) · {reviewEvents.length} gate events
        </span>
      </div>

      {/* Verdict summary */}
      <Card title="Gate verdicts">
        {!verdicts.length ? (
          <Empty>No critic or reviewer agents in this session.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {verdicts.map((v) => (
              <div
                key={v.aid}
                className="flex items-center gap-3 p-2.5 bg-ink-800 border border-line rounded-lg"
              >
                <Link
                  to={`/sessions/${sid}/agents/${v.aid}`}
                  className="font-mono text-sm text-accent hover:underline"
                >
                  {v.aid}
                </Link>
                <span className="text-muted text-xs">{v.agent.role} · {v.agent.status}</span>
                <span className="ml-auto">
                  {v.verdict ? (
                    <VerdictBadge verdict={v.verdict} />
                  ) : (
                    <span className="text-muted text-xs">no verdict yet</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Per-gate deep dive */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3.5">
        {reviewers.map(([aid, a]) => (
          <ReviewerAgentPanel key={aid} sid={sid} aid={aid} agent={a} />
        ))}
      </div>

      {/* Review events timeline */}
      <Card title="Gate event timeline">
        {!reviewEvents.length ? (
          <Empty>No quality-gate events yet.</Empty>
        ) : (
          <div className="font-mono text-xs max-h-96 overflow-y-auto">
            {reviewEvents.map((e, i) => (
              <div key={i} className="flex gap-2 py-1 border-b border-line/40">
                <span className="text-muted shrink-0 w-[70px]">{fmtTs(e.timestamp)}</span>
                <span className="text-accent shrink-0 w-[180px]">{e.type}</span>
                <span className="break-words">
                  {typeof e.data === "string" ? e.data : JSON.stringify(e.data)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Work agents under review */}
      <Card title="Work Agents Under Review">
        {!workAgents.length ? (
          <Empty>No work agents.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {workAgents.map(([aid, a]) => (
              <div
                key={aid}
                className="flex items-center gap-3 p-2.5 bg-ink-800 border border-line rounded-lg"
              >
                <Link
                  to={`/sessions/${sid}/agents/${aid}`}
                  className="font-mono text-sm text-accent hover:underline"
                >
                  {aid}
                </Link>
                <span className="text-muted text-xs">{a.role}</span>
                <span className="ml-auto text-xs text-muted">
                  {a.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function ReviewerAgentPanel({
  sid,
  aid,
  agent,
}: {
  sid: string;
  aid: string;
  agent: AgentStateResponse;
}) {
  const { data: attempts } = useAgentAttempts(sid, aid);
  const latestAttempt = attempts?.[attempts.length - 1]?.attempt_id;
  const { data: raw } = useAgentRaw(sid, aid, latestAttempt, 16384);
  const { data: controller } = useAgentController(sid, aid, 50, latestAttempt);
  const { data: audit } = useAgentAudit(sid, aid, 50, latestAttempt);

  return (
    <Card
      title={aid}
      right={
        <Link
          to={`/sessions/${sid}/agents/${aid}`}
          className="text-xs text-accent hover:underline"
        >
          full page →
        </Link>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="text-xs text-muted">
          status: {agent.status} · devin: {agent.devin_session_id ?? "—"}
        </div>
        <Terminal text={raw?.content ?? agent.visible_screen ?? ""} className="h-48" />
        <div className="text-xs font-mono">
          <div className="text-muted uppercase tracking-wide mt-1">
            Recent controller decisions
          </div>
          {!controller || !controller.length ? (
            <Empty>none</Empty>
          ) : (
            controller.slice(-5).map((c, i) => (
              <div key={i} className="py-0.5 border-b border-line/40">
                <span className="text-muted">{fmtTs(c.timestamp)}</span>{" "}
                <span className="text-accent">{c.decision?.action ?? "?"}</span>{" "}
                <span className="text-muted">{c.decision?.reason ?? ""}</span>
              </div>
            ))
          )}
        </div>
        <div className="text-xs font-mono">
          <div className="text-muted uppercase tracking-wide mt-1">Audit</div>
          {!audit || !audit.length ? (
            <Empty>none</Empty>
          ) : (
            audit.slice(-5).map((a, i) => (
              <div key={i} className="py-0.5 border-b border-line/40">
                <span className="text-muted">{fmtTs(a.timestamp)}</span>{" "}
                <span className="text-accent">{String(a.event ?? a.type ?? "?")}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </Card>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const v = verdict.toUpperCase();
  const isApprove = v.includes("APPROVE");
  const isReject = v.includes("REJECT") || v.includes("REVISE") || v.includes("REVISION");
  const cls = isApprove
    ? "text-accent2 border-accent2 bg-accent2/10"
    : isReject
      ? "text-danger border-danger bg-danger/10"
      : "text-warn border-warn bg-warn/10";
  return (
    <span className={`text-xs px-2 py-0.5 rounded border ${cls}`}>
      {verdict}
    </span>
  );
}

function extractVerdict(text: string): string | null {
  const m = text.match(VERDICT_RE);
  return m ? m[0] : null;
}

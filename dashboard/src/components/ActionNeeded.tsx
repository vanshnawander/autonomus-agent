import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api";
import { describeDecision, keyLabel, roleLabel, splitTerminalExcerpt, summarizeControllerError } from "@/lib/format";
import type { AgentStateResponse, ApprovalItem, Risk } from "@/lib/types";
import { Chip, Icon } from "./ui";

function Question({ text }: { text?: string | null }) {
  const { text: q, excerpt } = splitTerminalExcerpt(text);
  return (
    <>
      {q && <p className="action-question">{q}</p>}
      {excerpt && (
        <div className="terminal-excerpt">
          <span className="proposed-label">The terminal shows:</span>
          <pre>{excerpt}</pre>
        </div>
      )}
    </>
  );
}

const RISK_TONE: Record<Risk, "ok" | "warn" | "bad" | "muted"> = {
  low: "ok",
  medium: "warn",
  high: "bad",
  unknown: "muted",
};

function ApprovalCard({
  sid,
  item,
  agent,
  onDone,
}: {
  sid: string;
  item: ApprovalItem;
  agent?: AgentStateResponse;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const d = item.decision;

  const resolve = async (approved: boolean) => {
    setBusy(approved ? "approve" : "deny");
    setErr(null);
    try {
      await apiClient.resolveApproval(sid, item.id, approved, note.trim() || undefined);
      onDone();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="action-card tone-border-warn">
      <header className="action-card-head">
        <Icon name="question" />
        <span>
          <strong>{item.agent_id}</strong>
          {agent && <span className="muted"> · {roleLabel(agent.role)}</span>} wants your approval
        </span>
        <Chip tone={RISK_TONE[item.risk] ?? "muted"}>{item.risk} risk</Chip>
      </header>
      <Question text={item.question} />
      {d && d.action !== "ask_human" && d.action !== "wait" && (
        <div className="proposed">
          <span className="proposed-label">If you approve, the controller will:</span>
          <span className="proposed-action">{describeDecision(d)}</span>
          {d.text && (d.text.length > 60 || d.text.includes("\n")) && <pre className="proposed-text">{d.text}</pre>}
          {d.key && !d.text && <kbd>{keyLabel(d.key)}</kbd>}
        </div>
      )}
      {d?.reason && (
        <details className="why">
          <summary>Why the controller wants this</summary>
          <p>{d.reason}</p>
        </details>
      )}
      <div className="action-row">
        <label className="grow">
          <span className="sr-only">Note for the agent (optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note (sent with your decision)" />
        </label>
        <button className="btn btn-ok" disabled={!!busy} onClick={() => resolve(true)}>
          <Icon name="check" /> {busy === "approve" ? "Approving…" : "Approve"}
        </button>
        <button className="btn btn-danger" disabled={!!busy} onClick={() => resolve(false)}>
          <Icon name="cross" /> {busy === "deny" ? "Denying…" : "Deny"}
        </button>
      </div>
      {err && <p className="inline-error">{err}</p>}
    </article>
  );
}

function AttentionCard({
  sid,
  agent,
  onShowTerminal,
}: {
  sid: string;
  agent: AgentStateResponse;
  onShowTerminal: (aid: string) => void;
}) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const send = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await apiClient.sendFeedback(sid, reply.trim(), agent.agent_id, "immediate");
      setReply("");
      setSent(true);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="action-card tone-border-warn">
      <header className="action-card-head">
        <Icon name="question" />
        <span>
          <strong>{agent.agent_id}</strong>
          <span className="muted"> · {roleLabel(agent.role)}</span> needs your input
        </span>
        <button className="btn btn-sm btn-ghost" onClick={() => onShowTerminal(agent.agent_id)}>
          <Icon name="terminal" /> Show terminal
        </button>
      </header>
      <Question text={agent.attention} />
      <div className="action-row">
        <label className="grow">
          <span className="sr-only">Reply to {agent.agent_id}</span>
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={2}
            placeholder="Type your answer. It is typed into the agent's terminal right away."
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            }}
          />
        </label>
        <button className="btn btn-primary" disabled={busy || !reply.trim()} onClick={send}>
          <Icon name="send" /> {busy ? "Sending…" : "Send reply"}
        </button>
      </div>
      {sent && !err && <p className="inline-ok">Reply sent.</p>}
      {err && <p className="inline-error">{err}</p>}
    </article>
  );
}

/** Everything that is blocked on a human. Renders nothing when there is nothing to do. */
export function ActionNeeded({
  sid,
  approvals,
  agents,
  controllerError,
  onApprovalResolved,
  onShowTerminal,
}: {
  sid: string;
  approvals: ApprovalItem[];
  agents: Record<string, AgentStateResponse>;
  controllerError: string | null;
  onApprovalResolved: () => void;
  onShowTerminal: (aid: string) => void;
}) {
  const approvalAgents = new Set(approvals.map((a) => a.agent_id));
  const attention = Object.values(agents).filter((a) => a.attention && !approvalAgents.has(a.agent_id));
  const count = approvals.length + attention.length + (controllerError ? 1 : 0);
  if (!count) return null;

  return (
    <section className="action-needed" id="action-needed" aria-labelledby="action-needed-title">
      <h2 id="action-needed-title">
        <span className="pulse-dot" aria-hidden="true" />
        Action needed <span className="count-badge">{count}</span>
      </h2>
      {approvals.map((item) => (
        <ApprovalCard key={item.id} sid={sid} item={item} agent={agents[item.agent_id]} onDone={onApprovalResolved} />
      ))}
      {attention.map((agent) => (
        <AttentionCard key={agent.agent_id} sid={sid} agent={agent} onShowTerminal={onShowTerminal} />
      ))}
      {controllerError && (
        <article className="action-card tone-border-bad">
          <header className="action-card-head">
            <Icon name="alert" />
            <span>
              <strong>Controller error:</strong> {summarizeControllerError(controllerError)}
            </span>
          </header>
          <p className="action-question">
            The controller LLM that watches the agents couldn't decide the next step. Agents keep running, but nobody is
            answering their prompts. It retries on its own; if this persists, check the API key, quota or model in
            .env, or answer the agent yourself from the terminal below.
          </p>
          <details className="why">
            <summary>Full error</summary>
            <pre className="raw-error">{controllerError}</pre>
          </details>
        </article>
      )}
    </section>
  );
}

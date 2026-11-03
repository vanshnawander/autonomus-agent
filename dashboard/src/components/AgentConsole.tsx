import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useLiveTerminal } from "@/hooks/useOrchestrator";
import { apiClient, errorMessage } from "@/lib/api";
import {
  agentStatusLabel,
  agentStatusTone,
  cliLabel,
  describeDecision,
  isControllerErrorDecision,
  roleLabel,
  stripAnsi,
  summarizeControllerError,
  truncate,
} from "@/lib/format";
import type { AgentStateResponse, FeedbackMode } from "@/lib/types";
import { Chip, CliBadge, Icon } from "./ui";

const FEEDBACK_MODES: { mode: FeedbackMode; label: string; help: string }[] = [
  {
    mode: "immediate",
    label: "Send now",
    help: "Types your message into the agent's terminal right away and presses Enter.",
  },
  {
    mode: "context",
    label: "Add as guidance for next step",
    help: "Doesn't touch the terminal. The controller reads it and uses it when it decides what to do next.",
  },
  {
    mode: "interrupt",
    label: "Interrupt and send",
    help: "Presses Ctrl-C to stop what the agent is doing, then types your message.",
  },
];

/** Live terminal of one agent with direct input and feedback controls. */
export function AgentConsole({ sid, agent }: { sid: string; agent: AgentStateResponse }) {
  const aid = agent.agent_id;
  const isLive = agent.alive === true;
  const live = useLiveTerminal(sid, aid, isLive);
  const screen = stripAnsi(live || agent.visible_screen || "");
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState("");
  const [mode, setMode] = useState<FeedbackMode>(isLive ? "immediate" : "context");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const termRef = useRef<HTMLPreElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => {
    const el = termRef.current;
    if (el && stickToBottom) el.scrollTop = el.scrollHeight;
  }, [screen, stickToBottom]);

  const run = async (label: string, fn: () => Promise<unknown>, okText?: string) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
      if (okText) setMsg({ tone: "ok", text: okText });
      return true;
    } catch (e) {
      setMsg({ tone: "bad", text: errorMessage(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const sendInput = async () => {
    if (!input || !isLive) return;
    if (await run("input", () => apiClient.forceInput(sid, aid, { type: "send_line", text: input }))) setInput("");
  };
  const sendKey = (key: "enter" | "escape") =>
    run(key, () => apiClient.forceInput(sid, aid, { type: "press_key", key }));
  const sendCtrlC = () => run("ctrlc", () => apiClient.forceInput(sid, aid, { type: "send_ctrl_c" }));

  const sendFeedback = async () => {
    if (!feedback.trim()) return;
    const label = FEEDBACK_MODES.find((m) => m.mode === mode)?.label ?? mode;
    const ok = await run(
      "feedback",
      () => apiClient.sendFeedback(sid, feedback.trim(), aid, mode),
      mode === "context" || !isLive ? "Saved as guidance for the controller's next step." : `${label}: delivered.`,
    );
    if (ok) setFeedback("");
  };

  const pauseOrResume = () =>
    run("pause", () =>
      agent.status === "paused" ? apiClient.resumeAgentProcess(sid, aid) : apiClient.pauseAgent(sid, aid),
    );
  const stop = () => {
    if (!confirm(`Stop ${aid}? The run will pause at this stage until you resume it.`)) return;
    run("stop", () => apiClient.stopAgent(sid, aid), "Stop requested.");
  };
  const restart = () => {
    if (!confirm(`Restart ${aid}? Its previous conversation is resumed when the CLI supports it.`)) return;
    run("restart", () => apiClient.restartAgent(sid, aid, true), "Restart requested.");
  };

  const d = agent.last_decision;

  return (
    <div className="console">
      <div className="console-head">
        <div className="console-title">
          <strong>{aid}</strong>
          <span className="muted">{roleLabel(agent.role)}</span>
          <CliBadge cli={agent.agent_cli} />
          <Chip tone={agentStatusTone(agent)} dot={isLive}>
            {agentStatusLabel(agent)}
          </Chip>
        </div>
        <div className="console-controls">
          {isLive && (
            <button className="btn btn-sm" onClick={pauseOrResume} disabled={!!busy}>
              <Icon name={agent.status === "paused" ? "play" : "pause"} />
              {agent.status === "paused" ? "Unpause" : "Pause"}
            </button>
          )}
          {isLive && (
            <button className="btn btn-sm btn-danger" onClick={stop} disabled={!!busy}>
              <Icon name="stop" /> Stop
            </button>
          )}
          <button className="btn btn-sm" onClick={restart} disabled={!!busy}>
            <Icon name="retry" /> Restart
          </button>
          <Link className="btn btn-sm btn-ghost" to={`/sessions/${sid}/agents/${aid}`}>
            Details <Icon name="chevron" />
          </Link>
        </div>
      </div>

      <div className={`term ${!isLive && !screen ? "term-short" : ""}`}>
        <div className="term-bar">
          <span>{cliLabel(agent.agent_cli)} terminal</span>
          <span className={`term-state ${isLive ? "is-live" : ""}`}>
            {isLive ? "LIVE" : "NOT RUNNING — last recorded screen"}
          </span>
        </div>
        <pre
          ref={termRef}
          className="term-screen"
          tabIndex={0}
          aria-label={`${aid} terminal output`}
          onScroll={(e) => {
            const el = e.currentTarget;
            setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
        >
          {screen || (
            <span className="muted">
              {isLive
                ? "Connecting to the terminal…"
                : "This agent isn't running. Open Details to replay its recorded output."}
            </span>
          )}
        </pre>
      </div>

      <fieldset className="console-input" disabled={!isLive}>
        <legend className="sr-only">Type into the terminal</legend>
        <label className="grow">
          <span className="sr-only">Line to send</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendInput()}
            placeholder={isLive ? "Type a line and press Enter to send it to the terminal" : "Terminal input is available while the agent runs"}
            className="mono"
          />
        </label>
        <button className="btn btn-sm" onClick={sendInput} disabled={!input || !!busy}>
          Send line
        </button>
        <button className="btn btn-sm" onClick={() => sendKey("enter")} title="Press Enter" disabled={!!busy}>
          Enter
        </button>
        <button className="btn btn-sm" onClick={() => sendKey("escape")} title="Press Escape" disabled={!!busy}>
          Esc
        </button>
        <button className="btn btn-sm btn-danger" onClick={sendCtrlC} title="Press Ctrl-C (interrupt)" disabled={!!busy}>
          Ctrl-C
        </button>
      </fieldset>

      <div className="feedback">
        <div className="feedback-head">
          <strong>Give the agent feedback</strong>
          <span className="muted small">Choose how it is delivered:</span>
        </div>
        <div className="mode-options" role="radiogroup" aria-label="How to deliver feedback">
          {FEEDBACK_MODES.map((m) => (
            <label key={m.mode} className={`mode-option ${mode === m.mode ? "is-selected" : ""}`}>
              <input
                type="radio"
                name={`feedback-mode-${aid}`}
                value={m.mode}
                checked={mode === m.mode}
                onChange={() => setMode(m.mode)}
              />
              <span>
                <strong>{m.label}</strong>
                <small>{m.help}</small>
              </span>
            </label>
          ))}
        </div>
        {!isLive && mode !== "context" && (
          <p className="hint">The agent isn't running, so this will be saved as guidance for its next step instead.</p>
        )}
        <div className="action-row">
          <label className="grow">
            <span className="sr-only">Feedback message</span>
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={2}
              placeholder="e.g. Use the conda Python for every command, and save raw search results."
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendFeedback();
              }}
            />
          </label>
          <button className="btn btn-primary" onClick={sendFeedback} disabled={!feedback.trim() || !!busy}>
            <Icon name="send" /> {busy === "feedback" ? "Sending…" : FEEDBACK_MODES.find((m) => m.mode === mode)?.label}
          </button>
        </div>
      </div>

      {msg && <p className={msg.tone === "ok" ? "inline-ok" : "inline-error"}>{msg.text}</p>}

      {d && (
        <div className="last-decision">
          <span className="muted small">Controller's latest decision</span>
          {isControllerErrorDecision(d) ? (
            <div className="tone-text-bad">Controller error: {summarizeControllerError(d.reason)}</div>
          ) : (
            <div>
              <strong>{describeDecision(d)}</strong>
              {d.reason && <span className="muted"> — {truncate(d.reason, 300)}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

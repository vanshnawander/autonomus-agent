import { useEffect, useMemo, useState } from "react";
import { useAgentClis, usePreflight } from "@/hooks/useOrchestrator";
import { apiClient, errorMessage } from "@/lib/api";
import { useAppData } from "@/lib/appContext";
import { checkRows } from "@/lib/checks";
import { resolveClis } from "@/lib/clis";
import { cliLabel, isGateRole, ROLE_HELP, ROLE_OPTIONS, roleLabel } from "@/lib/format";
import { PRESETS, suggestSessionId } from "@/lib/presets";
import type { ResearchPreset } from "@/lib/presets";
import type { AgentSpec, ApprovalMode } from "@/lib/types";
import { CliCard } from "./AgentClis";
import { SetupChecklist } from "./SetupChecklist";
import { Icon } from "./ui";

const STEPS = ["Basics", "Brief", "Agents", "Review & start"];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function cloneAgents(agents: AgentSpec[]): AgentSpec[] {
  return agents.map((agent) => ({ ...agent }));
}

function makeBrief(preset: ResearchPreset, topic: string, goal: string, constraints: string): string {
  const constraintLines = constraints
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");

  return `# Project Brief

## Research topic
${topic.trim() || "[Define the research topic]"}

## Objective
${goal.trim()}

## Research standard
Produce an auditable, reproducible study. Separate sourced facts, hypotheses, observed results, and interpretation. Preserve negative results and failed attempts.

## Constraints
${constraintLines || "- Define project constraints before starting."}

## Required workflow
1. Verify the literature against primary sources and maintain a search ledger.
2. Design falsifiable methodology with baselines, controls, ablations, and uncertainty.
3. Run tested experiments with immutable configs, logs, metrics, and environment records.
4. Apply an adversarial critic gate after every stage.
5. Require a separate reviewer acceptance gate after every critic approval.
6. Write the final paper using only critic- and reviewer-approved, traceable evidence.

## Deliverables
- Validated literature records and claim-level citations.
- Approved methodology and experiment manifest.
- Reproducible code, tests, raw logs, metrics, and figures.
- Reviewer reports and a publication-ready paper with claim traceability.

## Template
${preset.label}
`;
}

/** Order the server will run: each work stage followed by the gates present. */
function previewPipeline(agents: AgentSpec[]): string[] {
  const roles = agents.map((a) => a.role);
  const gates = ["critic", "reviewer"].filter((g) => roles.includes(g));
  const out: string[] = [];
  for (const role of roles) {
    if (isGateRole(role)) continue;
    out.push(roleLabel(role), ...gates.map(roleLabel));
  }
  return out;
}

export function NewRunWizard({
  onClose,
  onCreated,
  initialPresetId,
}: {
  onClose: () => void;
  onCreated: (sid: string) => void;
  initialPresetId?: string;
}) {
  const initialPreset = PRESETS.find((preset) => preset.id === initialPresetId) ?? PRESETS[0];
  const { health, online } = useAppData();
  const preflight = usePreflight();
  const agentClis = useAgentClis();
  const resolved = resolveClis(agentClis.data, preflight.data, health);

  const [step, setStep] = useState(0);
  const [presetId, setPresetId] = useState(initialPreset.id);
  const [topic, setTopic] = useState("");
  const [sidEdited, setSidEdited] = useState<string | null>(null);
  const [autoSuffix] = useState(() => suggestSessionId("x").split("-").slice(-4).join("-"));
  const [workspaceEdited, setWorkspaceEdited] = useState<string | null>(null);
  const [goal, setGoal] = useState(initialPreset.goal);
  const [constraints, setConstraints] = useState(initialPreset.constraints.join("\n"));
  const [briefEdited, setBriefEdited] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSpec[]>(cloneAgents(initialPreset.agents));
  const [cliChoice, setCliChoice] = useState<string | null>(null);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("autonomous");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const preset = PRESETS.find((item) => item.id === presetId) ?? PRESETS[0];
  const slug = (topic || preset.label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const sid = (sidEdited ?? `${slug || "research"}-${autoSuffix}`).trim();
  const workspace = (workspaceEdited ?? sid).trim();
  const brief = briefEdited ?? makeBrief(preset, topic, goal, constraints);
  const constraintList = useMemo(
    () => constraints.split("\n").map((l) => l.trim()).filter(Boolean),
    [constraints],
  );

  const installed = resolved.clis.filter((c) => c.installed);
  const defaultCli =
    cliChoice ??
    (resolved.clis.find((c) => c.name === resolved.defaultCli)?.installed || !installed.length
      ? resolved.defaultCli
      : installed[0].name);
  const cliInfo = (name?: string | null) => resolved.clis.find((c) => c.name === (name || defaultCli));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const applyPreset = (id: string) => {
    const next = PRESETS.find((item) => item.id === id) ?? PRESETS[0];
    setPresetId(next.id);
    setGoal(next.goal);
    setConstraints(next.constraints.join("\n"));
    setAgents(cloneAgents(next.agents));
    setBriefEdited(null);
  };

  const updateAgent = (index: number, patch: Partial<AgentSpec>) =>
    setAgents((current) => current.map((agent, i) => (i === index ? { ...agent, ...patch } : agent)));

  const validate = (upTo: number): string | null => {
    if (upTo >= 0) {
      if (!ID_RE.test(sid)) return "Run ID must start with a letter or digit and use only letters, digits, dots, dashes or underscores.";
      if (!workspace || workspace.startsWith("/") || workspace.includes("..")) {
        return "Workspace must be a folder name inside runs/ (no leading “/” and no “..”).";
      }
    }
    if (upTo >= 1) {
      if (!goal.trim()) return "Describe the goal of the run.";
      if (brief.trim().length < 80) return "The project brief needs more detail (at least a few sentences) to guide the agents.";
    }
    if (upTo >= 2) {
      if (!agents.length) return "Add at least one agent.";
      if (agents.some((a) => !ID_RE.test(a.agent_id.trim()))) return "Every agent needs an id made of letters, digits, dots or dashes.";
      const ids = agents.map((a) => a.agent_id.trim());
      if (new Set(ids).size !== ids.length) return "Agent ids must be unique.";
      const roles = agents.map((a) => a.role);
      if (new Set(roles).size !== roles.length) return "Each role can only be used by one agent.";
      if (!agents.some((a) => !isGateRole(a.role))) return "Add at least one work stage (not only critic/reviewer).";
      const def = cliInfo(defaultCli);
      if (def && !def.installed && (agentClis.data || preflight.data)) return `${def.display_name} isn't installed on the server. Pick another default CLI.`;
      const bad = agents.find((a) => a.agent_cli && cliInfo(a.agent_cli)?.installed === false);
      if (bad) return `${bad.agent_id} uses ${cliLabel(bad.agent_cli)}, which isn't installed.`;
    }
    return null;
  };

  const rows = checkRows(preflight.data, defaultCli);
  const failedChecks = rows.filter(
    (r) => !r.ok && !r.optional && !(r.name === "controller" && approvalMode === "manual") && !(r.name.startsWith("cli:") || r.name === "devin"),
  );
  const controllerMissing = approvalMode === "autonomous" && rows.some((r) => r.name === "controller" && !r.ok);
  const canCreate = online && !controllerMissing && (failedChecks.length === 0 || acknowledged);

  const next = () => {
    const issue = validate(step);
    if (issue) {
      setErr(issue);
      return;
    }
    setErr(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const goTo = (target: number) => {
    if (target <= step) {
      setErr(null);
      setStep(target);
      return;
    }
    const issue = validate(target - 1);
    if (issue) setErr(issue);
    else {
      setErr(null);
      setStep(target);
    }
  };

  const create = async () => {
    if (busy) return;
    const issue = validate(3);
    if (issue) {
      setErr(issue);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const created = await apiClient.createSession({
        session_id: sid,
        goal: topic.trim() ? `${goal.trim()}\n\nTopic: ${topic.trim()}` : goal.trim(),
        constraints: constraintList,
        agents: agents.map((a) => ({
          agent_id: a.agent_id.trim(),
          role: a.role,
          extra_prompt: a.extra_prompt?.trim() || null,
          ...(a.agent_cli ? { agent_cli: a.agent_cli } : {}),
          ...(a.model?.trim() ? { model: a.model.trim() } : {}),
        })),
        approval_mode: approvalMode,
        workspace,
        project_brief: brief.trim(),
        agent_cli: defaultCli,
      });
      onCreated(created.session_id || sid);
      onClose();
    } catch (e) {
      setErr(`The server refused to start the run: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="wizard-title" className="wizard">
        <header className="wizard-head">
          <div>
            <h2 id="wizard-title">New research run</h2>
            <p className="muted small">
              Step {step + 1} of {STEPS.length}: {STEPS[step]}
            </p>
          </div>
          <button onClick={onClose} className="btn btn-ghost btn-icon" aria-label="Close" disabled={busy}>
            <Icon name="close" />
          </button>
        </header>

        <ol className="wizard-steps">
          {STEPS.map((label, index) => (
            <li key={label}>
              <button
                onClick={() => goTo(index)}
                className={`wizard-step ${index === step ? "is-current" : index < step ? "is-done" : ""}`}
                aria-current={index === step ? "step" : undefined}
              >
                <span className="wizard-step-num">{index < step ? <Icon name="check" /> : index + 1}</span>
                <span className="wizard-step-label">{label}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className="wizard-body">
          {step === 0 && (
            <div className="stack">
              <fieldset className="field">
                <legend className="field-label">Template</legend>
                <div className="preset-grid">
                  {PRESETS.map((item) => (
                    <label key={item.id} className={`preset-card ${presetId === item.id ? "is-selected" : ""}`}>
                      <input
                        type="radio"
                        name="preset"
                        className="sr-only"
                        checked={presetId === item.id}
                        onChange={() => applyPreset(item.id)}
                      />
                      <strong>{item.label}</strong>
                      <span>{item.description}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="field">
                <span className="field-label">Research topic</span>
                <input
                  autoFocus
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g. Sliding-window attention for flow-matching models"
                />
                <span className="field-help">Used to name the run and at the top of the project brief.</span>
              </label>
              <div className="form-grid">
                <label className="field">
                  <span className="field-label">Run ID</span>
                  <input
                    value={sid}
                    onChange={(e) => setSidEdited(e.target.value)}
                    className="mono"
                    aria-invalid={!ID_RE.test(sid)}
                  />
                  <span className="field-help">
                    Names the log folder.{" "}
                    {sidEdited !== null && (
                      <button className="link-btn" onClick={() => setSidEdited(null)}>
                        Use automatic id
                      </button>
                    )}
                  </span>
                </label>
                <label className="field">
                  <span className="field-label">Workspace folder</span>
                  <div className="input-prefix">
                    <span>runs/</span>
                    <input
                      value={workspace}
                      onChange={(e) => setWorkspaceEdited(e.target.value)}
                      className="mono"
                    />
                  </div>
                  <span className="field-help">
                    Where agents work and PROJECT_BRIEF.md is written.{" "}
                    {workspaceEdited !== null ? (
                      <button className="link-btn" onClick={() => setWorkspaceEdited(null)}>
                        Match run ID
                      </button>
                    ) : (
                      "Follows the run ID."
                    )}
                  </span>
                </label>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="brief-layout">
              <div className="stack">
                <label className="field">
                  <span className="field-label">Goal</span>
                  <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={5} />
                  <span className="field-help">One or two sentences: what should exist when the run is finished?</span>
                </label>
                <label className="field">
                  <span className="field-label">Constraints — one per line</span>
                  <textarea
                    value={constraints}
                    onChange={(e) => setConstraints(e.target.value)}
                    rows={9}
                    className="mono"
                  />
                  <span className="field-help">{constraintList.length} constraints. Agents must follow every one.</span>
                </label>
              </div>
              <label className="field">
                <span className="field-label">
                  Project brief (PROJECT_BRIEF.md){" "}
                  {briefEdited === null ? (
                    <span className="muted small">— generated from the fields; edit freely</span>
                  ) : (
                    <button className="link-btn" onClick={() => setBriefEdited(null)}>
                      Regenerate from fields
                    </button>
                  )}
                </span>
                <textarea
                  value={brief}
                  onChange={(e) => setBriefEdited(e.target.value)}
                  rows={20}
                  spellCheck
                  className="mono"
                />
              </label>
            </div>
          )}

          {step === 2 && (
            <div className="stack">
              <fieldset className="field">
                <legend className="field-label">Default agent CLI</legend>
                <p className="field-help">Every agent uses this unless you override it below.</p>
                {resolved.legacy && (
                  <p className="hint">This server only reports {resolved.clis.map((c) => c.display_name).join(", ")}.</p>
                )}
                <div className="cli-grid">
                  {resolved.clis.map((cli) => (
                    <CliCard
                      key={cli.name}
                      cli={cli}
                      name="default-cli"
                      isDefault={cli.name === resolved.defaultCli}
                      selected={cli.name === defaultCli}
                      onSelect={() => setCliChoice(cli.name)}
                    />
                  ))}
                </div>
              </fieldset>

              <fieldset className="field">
                <legend className="field-label">Agents</legend>
                <p className="field-help">
                  Planned order: {previewPipeline(agents).join(" → ") || "—"}
                </p>
                <ul className="agent-editor">
                  {agents.map((agent, index) => {
                    const info = cliInfo(agent.agent_cli);
                    return (
                      <li key={index} className="agent-editor-row">
                        <label className="field">
                          <span className="field-label">Agent id</span>
                          <input
                            value={agent.agent_id}
                            onChange={(e) => updateAgent(index, { agent_id: e.target.value })}
                            className="mono"
                          />
                        </label>
                        <label className="field">
                          <span className="field-label">Role</span>
                          <select value={agent.role} onChange={(e) => updateAgent(index, { role: e.target.value })} title={ROLE_HELP[agent.role]}>
                            {ROLE_OPTIONS.map((role) => (
                              <option key={role} value={role}>
                                {roleLabel(role)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          <span className="field-label">CLI</span>
                          <select
                            value={agent.agent_cli ?? ""}
                            onChange={(e) => updateAgent(index, { agent_cli: e.target.value || null })}
                          >
                            <option value="">Default ({cliLabel(defaultCli)})</option>
                            {resolved.clis.map((c) => (
                              <option key={c.name} value={c.name} disabled={!c.installed}>
                                {c.display_name}
                                {c.installed ? "" : " (not installed)"}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          <span className="field-label">Model</span>
                          <input
                            value={agent.model ?? ""}
                            onChange={(e) => updateAgent(index, { model: e.target.value })}
                            placeholder={info?.default_model ?? "CLI default"}
                            disabled={info ? !info.capabilities?.model_selection : false}
                            title={info?.model_hint || undefined}
                            className="mono"
                          />
                        </label>
                        <label className="field span-row">
                          <span className="field-label">Extra instruction (optional)</span>
                          <input
                            value={agent.extra_prompt ?? ""}
                            onChange={(e) => updateAgent(index, { extra_prompt: e.target.value })}
                            placeholder={ROLE_HELP[agent.role] ?? ""}
                          />
                        </label>
                        <button
                          onClick={() => setAgents((current) => current.filter((_, i) => i !== index))}
                          className="btn btn-sm btn-ghost agent-remove"
                          aria-label={`Remove ${agent.agent_id || "agent"}`}
                        >
                          <Icon name="close" /> Remove
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <button
                  onClick={() =>
                    setAgents((current) => [
                      ...current,
                      {
                        agent_id: `agent-${current.length + 1}`,
                        role: ROLE_OPTIONS.find((r) => !current.some((a) => a.role === r)) ?? "literature-survey",
                      },
                    ])
                  }
                  className="btn btn-sm"
                >
                  <Icon name="plus" /> Add agent
                </button>
              </fieldset>
            </div>
          )}

          {step === 3 && (
            <div className="stack">
              <fieldset className="field">
                <legend className="field-label">Who approves the agents' risky prompts?</legend>
                <div className="mode-options two">
                  <label className={`mode-option ${approvalMode === "manual" ? "is-selected" : ""}`}>
                    <input type="radio" name="approval" checked={approvalMode === "manual"} onChange={() => setApprovalMode("manual")} />
                    <span>
                      <strong>Manual</strong>
                      <small>The controller drives the agents, but every permission prompt waits for you to click Approve.</small>
                    </span>
                  </label>
                  <label className={`mode-option ${approvalMode === "autonomous" ? "is-selected" : ""}`}>
                    <input
                      type="radio"
                      name="approval"
                      checked={approvalMode === "autonomous"}
                      onChange={() => setApprovalMode("autonomous")}
                    />
                    <span>
                      <strong>Autonomous</strong>
                      <small>The controller approves routine low- and medium-risk prompts itself so the run keeps moving.</small>
                    </span>
                  </label>
                </div>
                <p className="field-help">
                  <Icon name="alert" /> In both modes, high-risk actions — deleting data, pushing or publishing, secrets,
                  deployments — always wait for a human.
                </p>
              </fieldset>

              <div className="review-grid">
                <div>
                  <h3 className="field-label">Summary</h3>
                  <dl className="facts">
                    <dt>Run ID</dt>
                    <dd><code>{sid}</code></dd>
                    <dt>Workspace</dt>
                    <dd><code>runs/{workspace}</code></dd>
                    <dt>Template</dt>
                    <dd>{preset.label}</dd>
                    {topic && (
                      <>
                        <dt>Topic</dt>
                        <dd>{topic}</dd>
                      </>
                    )}
                    <dt>Default CLI</dt>
                    <dd>{cliLabel(defaultCli)}</dd>
                    <dt>Agents</dt>
                    <dd>
                      {agents.map((a) => `${a.agent_id} (${roleLabel(a.role)}${a.agent_cli ? `, ${cliLabel(a.agent_cli)}` : ""}${a.model ? `, ${a.model}` : ""})`).join(", ")}
                    </dd>
                    <dt>Constraints</dt>
                    <dd>{constraintList.length}</dd>
                    <dt>Controller</dt>
                    <dd>{health?.llm_model ?? "unknown"}</dd>
                  </dl>
                </div>
                <div>
                  <h3 className="field-label">Server readiness</h3>
                  <SetupChecklist
                    preflight={preflight.data}
                    error={preflight.error}
                    defaultCli={defaultCli}
                    onRetry={preflight.refresh}
                  />
                  {controllerMissing && (
                    <p className="inline-error">Autonomous mode needs a working controller. Fix it or choose Manual.</p>
                  )}
                  {failedChecks.length > 0 && !controllerMissing && (
                    <label className="check">
                      <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                      Start anyway — I understand some agents may fail because of the problems above.
                    </label>
                  )}
                  {!online && <p className="inline-error">The API is offline.</p>}
                </div>
              </div>
            </div>
          )}

          {err && (
            <p className="inline-error wizard-error" role="alert">
              {err}
            </p>
          )}
        </div>

        <footer className="wizard-foot">
          <button onClick={onClose} className="btn btn-ghost" disabled={busy}>
            Cancel
          </button>
          <div className="wizard-foot-right">
            {step > 0 && (
              <button
                onClick={() => {
                  setErr(null);
                  setStep((s) => s - 1);
                }}
                className="btn"
                disabled={busy}
              >
                Back
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button onClick={next} className="btn btn-primary">
                Continue
              </button>
            ) : (
              <button onClick={create} disabled={busy || !canCreate} className="btn btn-primary">
                <Icon name="play" /> {busy ? "Starting…" : "Create and start"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

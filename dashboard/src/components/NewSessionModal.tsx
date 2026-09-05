import { useEffect, useMemo, useState } from "react";
import { useHealth } from "@/hooks/useOrchestrator";
import { apiClient } from "@/lib/api";
import { PRESETS, suggestSessionId } from "@/lib/presets";
import type { ResearchPreset } from "@/lib/presets";
import type { AgentSpec, ApprovalMode, PreflightResponse } from "@/lib/types";

const STEPS = ["Scope", "Project brief", "Pipeline", "Preflight"];
const ROLE_OPTIONS = [
  "literature-survey",
  "methodology",
  "experiment-executor",
  "paper-writer",
  "reviewer",
  "critic",
];

function cloneAgents(agents: AgentSpec[]): AgentSpec[] {
  return agents.map((agent) => ({ ...agent }));
}

function makeBrief(
  preset: ResearchPreset,
  topic: string,
  goal: string,
  constraints: string,
): string {
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

const fieldClass =
  "w-full bg-ink-950 border border-line rounded-lg px-3 py-2 text-xs text-fg placeholder:text-faint";
const labelClass = "text-[11px] font-semibold text-fg-dim";

export function NewSessionModal({
  onClose,
  onCreated,
  initialPresetId,
}: {
  onClose: () => void;
  onCreated: (sid: string) => void;
  initialPresetId?: string;
}) {
  const initialPreset =
    PRESETS.find((preset) => preset.id === initialPresetId) ?? PRESETS[0];
  const { health, online } = useHealth();
  const [step, setStep] = useState(0);
  const [presetId, setPresetId] = useState(initialPreset.id);
  const [sid, setSid] = useState(() => suggestSessionId("research"));
  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState(initialPreset.goal);
  const [constraints, setConstraints] = useState(initialPreset.constraints.join("\n"));
  const [workspace, setWorkspace] = useState("");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("manual");
  const [agents, setAgents] = useState<AgentSpec[]>(cloneAgents(initialPreset.agents));
  const [projectBrief, setProjectBrief] = useState(() =>
    makeBrief(initialPreset, "", initialPreset.goal, initialPreset.constraints.join("\n")),
  );
  const [briefDirty, setBriefDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [systemPreflight, setSystemPreflight] = useState<PreflightResponse | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [preflightNonce, setPreflightNonce] = useState(0);

  const preset = PRESETS.find((item) => item.id === presetId) ?? PRESETS[0];
  const finalSid = sid.trim();
  const finalWorkspace = workspace.trim() || finalSid;
  const constraintList = useMemo(
    () =>
      constraints
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    [constraints],
  );

  useEffect(() => {
    let active = true;
    setPreflightError(null);
    apiClient
      .preflight()
      .then((result) => {
        if (active) setSystemPreflight(result);
      })
      .catch((error: Error) => {
        if (active) {
          setSystemPreflight(null);
          setPreflightError(error.message);
        }
      });
    return () => {
      active = false;
    };
  }, [preflightNonce]);

  const applyPreset = (id: string) => {
    const next = PRESETS.find((item) => item.id === id) ?? PRESETS[0];
    const nextConstraints = next.constraints.join("\n");
    setPresetId(next.id);
    setGoal(next.goal);
    setConstraints(nextConstraints);
    setAgents(cloneAgents(next.agents));
    setProjectBrief(makeBrief(next, topic, next.goal, nextConstraints));
    setBriefDirty(false);
  };

  const updateAgent = (index: number, patch: Partial<AgentSpec>) => {
    setAgents((current) =>
      current.map((agent, agentIndex) =>
        agentIndex === index ? { ...agent, ...patch } : agent,
      ),
    );
  };
  const validate = (targetStep = step): string | null => {
    if (targetStep >= 0) {
      if (!topic.trim()) return "Research topic is required.";
      if (!goal.trim()) return "Objective is required.";
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(finalSid)) {
        return "Session ID must start with a letter or digit and contain only letters, digits, dots, dashes, or underscores.";
      }
    }
    if (targetStep >= 1 && projectBrief.trim().length < 80) {
      return "Project brief must contain enough detail to direct the research agents.";
    }
    if (targetStep >= 2) {
      if (!agents.length) return "Add at least one pipeline agent.";
      if (agents.some((agent) => !agent.agent_id.trim() || !agent.role.trim())) {
        return "Every agent needs an ID and role.";
      }
      const ids = agents.map((agent) => agent.agent_id.trim());
      if (new Set(ids).size !== ids.length) return "Agent IDs must be unique.";
      const roles = agents.map((agent) => agent.role.trim());
      if (new Set(roles).size !== roles.length) return "Each pipeline role may be assigned to only one agent.";
    }
    return null;
  };

  const next = () => {
    const issue = validate(step);
    if (issue) {
      setErr(issue);
      return;
    }
    setErr(null);
    if (step === 0 && !briefDirty) {
      setProjectBrief(makeBrief(preset, topic, goal, constraints));
    }
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const create = async () => {
    const issue = validate(3);
    if (issue) {
      setErr(issue);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await apiClient.createSession({
        session_id: finalSid,
        goal: `${goal.trim()}\n\nTopic: ${topic.trim()}`,
        constraints: constraintList,
        agents: agents.map((agent) => ({
          agent_id: agent.agent_id.trim(),
          role: agent.role,
          extra_prompt: agent.extra_prompt?.trim() || null,
        })),
        approval_mode: approvalMode,
        workspace: finalWorkspace,
        project_brief: projectBrief.trim(),
      });
      onCreated(finalSid);
      onClose();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const checkLabels: Record<string, string> = {
    controller: "OpenRouter controller",
    devin: "Devin CLI",
    python: "Conda Python",
    conda: "Conda environment",
    workspace: "Workspace root",
    trace_export: "Trace export",
    searxng: "Local SearXNG",
    server_inventory: "Experiment servers",
  };
  const preflight = [
    { label: "Orchestrator API", ok: online, value: online ? "Connected" : "Offline" },
    ...Object.entries(systemPreflight?.checks ?? {}).map(([name, check]) => ({
      label: checkLabels[name] ?? name,
      ok: check.ok,
      value: check.detail,
    })),
    { label: "Project workspace", ok: !!finalWorkspace, value: finalWorkspace },
    {
      label: "Project brief",
      ok: projectBrief.trim().length >= 80,
      value: `${projectBrief.trim().length} characters`,
    },
    {
      label: "Approval policy",
      ok: true,
      value:
        approvalMode === "autonomous"
          ? "Controller handles non-harmful requests"
          : "Human approves tool requests",
    },
  ];

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-3">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        className="wizard-shell w-[920px] max-w-full max-h-[94vh] overflow-hidden flex flex-col"
      >
        <header className="flex items-center gap-3 px-5 py-4 border-b border-line bg-ink-900">
          <div>
            <h2 id="new-session-title" className="m-0 text-base font-semibold">
              New research session
            </h2>
            <p className="m-0 mt-1 text-[11px] text-muted">
              Define the work before starting autonomous execution.
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto icon-button"
            aria-label="Close session wizard"
            title="Close"
          >
            x
          </button>
        </header>

        <div className="grid grid-cols-4 border-b border-line bg-ink-950">
          {STEPS.map((label, index) => (
            <button
              key={label}
              onClick={() => index <= step && setStep(index)}
              disabled={index > step}
              className={`wizard-step ${index === step ? "wizard-step-active" : ""}`}
            >
              <span>{index + 1}</span>
              {label}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto p-5 min-h-0 flex-1">
          {step === 0 && (
            <div className="flex flex-col gap-5">
              <section>
                <div className="section-label mb-2">Research template</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  {PRESETS.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => applyPreset(item.id)}
                      className={`preset-option ${presetId === item.id ? "preset-option-active" : ""}`}
                    >
                      <span className="font-semibold text-xs">{item.label}</span>
                      <span className="text-[10px] text-muted leading-relaxed mt-1">
                        {item.description}
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="flex flex-col gap-1.5">
                  <span className={labelClass}>Research topic</span>
                  <input
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    placeholder="Reference sliding-window attention for flow models"
                    className={fieldClass}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={labelClass}>Session ID</span>
                  <div className="flex gap-2">
                    <input
                      value={sid}
                      onChange={(event) => setSid(event.target.value)}
                      placeholder={finalSid}
                      className={fieldClass}
                    />
                    <button
                      onClick={() => setSid(suggestSessionId(topic || goal))}
                      className="secondary-button shrink-0"
                    >
                      Generate
                    </button>
                  </div>
                </label>
              </section>

              <label className="flex flex-col gap-1.5">
                <span className={labelClass}>Objective</span>
                <textarea
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  rows={4}
                  className={fieldClass}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={labelClass}>Workspace</span>
                <input
                  value={workspace}
                  onChange={(event) => setWorkspace(event.target.value)}
                  placeholder={`runs/${finalSid}`}
                  className={`${fieldClass} font-mono`}
                />
                <span className="text-[10px] text-muted">
                  The backend creates this project-local workspace and writes PROJECT_BRIEF.md.
                </span>
              </label>

              <div>
                <div className={labelClass}>Approval mode</div>
                <div className="segmented-control mt-2">
                  <button
                    onClick={() => setApprovalMode("manual")}
                    className={approvalMode === "manual" ? "selected" : ""}
                  >
                    Manual approvals
                  </button>
                  <button
                    onClick={() => setApprovalMode("autonomous")}
                    className={approvalMode === "autonomous" ? "selected" : ""}
                  >
                    Autonomous controller
                  </button>
                </div>
                <p className="text-[10px] text-muted mt-2 mb-0">
                  {approvalMode === "manual"
                    ? "The OpenRouter controller monitors the agent, but tool requests wait for a human decision."
                    : "The OpenRouter controller may approve expected non-harmful operations. High-risk actions still require a human."}
                </p>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="grid grid-cols-1 lg:grid-cols-[0.7fr_1.3fr] gap-4">
              <section className="flex flex-col gap-3">
                <div>
                  <div className="section-label">Operating constraints</div>
                  <p className="text-[11px] text-muted leading-relaxed">
                    One enforceable constraint per line. These are persisted in the session manifest and brief.
                  </p>
                </div>
                <textarea
                  value={constraints}
                  onChange={(event) => setConstraints(event.target.value)}
                  rows={14}
                  className={`${fieldClass} font-mono resize-y`}
                />
                <button
                  onClick={() => {
                    setProjectBrief(makeBrief(preset, topic, goal, constraints));
                    setBriefDirty(false);
                  }}
                  className="secondary-button self-start"
                >
                  Regenerate brief
                </button>
              </section>
              <label className="flex flex-col gap-2 min-w-0">
                <span className={labelClass}>PROJECT_BRIEF.md</span>
                <textarea
                  value={projectBrief}
                  onChange={(event) => {
                    setProjectBrief(event.target.value);
                    setBriefDirty(true);
                  }}
                  rows={24}
                  spellCheck
                  className={`${fieldClass} font-mono resize-y leading-relaxed`}
                />
              </label>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col gap-4">
              <div>
                <div className="section-label">Agent pipeline</div>
                <p className="text-[11px] text-muted leading-relaxed mb-0">
                  Each work stage runs through an adversarial critic, then an independent acceptance reviewer.
                </p>
              </div>
              <div className="overflow-x-auto border border-line rounded-lg">
                <table className="workbench-table min-w-[680px]">
                  <thead>
                    <tr>
                      <th className="w-[190px]">Agent ID</th>
                      <th className="w-[220px]">Role</th>
                      <th>Additional stage instruction</th>
                      <th className="w-[64px]">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map((agent, index) => (
                      <tr key={index}>
                        <td>
                          <input
                            value={agent.agent_id}
                            onChange={(event) => updateAgent(index, { agent_id: event.target.value })}
                            className={`${fieldClass} font-mono`}
                          />
                        </td>
                        <td>
                          <select
                            value={agent.role}
                            onChange={(event) => updateAgent(index, { role: event.target.value })}
                            className={fieldClass}
                          >
                            {ROLE_OPTIONS.map((role) => (
                              <option key={role} value={role}>
                                {role}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            value={agent.extra_prompt ?? ""}
                            onChange={(event) => updateAgent(index, { extra_prompt: event.target.value })}
                            placeholder="Optional"
                            className={fieldClass}
                          />
                        </td>
                        <td className="text-center">
                          <button
                            onClick={() => setAgents((current) => current.filter((_, i) => i !== index))}
                            className="icon-button"
                            aria-label={`Remove ${agent.agent_id || "agent"}`}
                            title="Remove agent"
                          >
                            x
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                onClick={() =>
                  setAgents((current) => [
                    ...current,
                    { agent_id: `agent-${current.length + 1}`, role: "literature-survey" },
                  ])
                }
                className="secondary-button self-start"
              >
                + Add agent
              </button>
            </div>
          )}

          {step === 3 && (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_0.8fr] gap-5">
              <section>
                <div className="section-label mb-3">Configuration preflight</div>
                <div className="border border-line rounded-lg overflow-hidden">
                  {preflight.map((item) => (
                    <div
                      key={item.label}
                      className="grid grid-cols-[18px_180px_1fr] gap-2 items-center px-3 py-2.5 border-b border-line-soft last:border-b-0"
                    >
                      <span className={`status-dot ${item.ok ? "status-ok" : "status-error"}`} />
                      <span className="text-xs text-fg-dim">{item.label}</span>
                      <span className="text-[11px] font-mono text-right break-all">{item.value}</span>
                    </div>
                  ))}
                </div>
                {preflightError && (
                  <div className="mt-3 flex items-center gap-2 text-danger text-[11px]">
                    <span>Preflight failed: {preflightError}</span>
                    <button
                      onClick={() => setPreflightNonce((value) => value + 1)}
                      className="secondary-button"
                    >
                      Retry
                    </button>
                  </div>
                )}
                {!preflightError && !systemPreflight && (
                  <p className="text-muted text-[11px]">Running system checks...</p>
                )}
                {systemPreflight && !systemPreflight.ready && (
                  <p className="text-danger text-[11px]">
                    Resolve failed required checks before starting.
                  </p>
                )}
              </section>
              <section>
                <div className="section-label mb-3">Run summary</div>
                <dl className="summary-list">
                  <dt>Session</dt>
                  <dd>{finalSid}</dd>
                  <dt>Topic</dt>
                  <dd>{topic}</dd>
                  <dt>Template</dt>
                  <dd>{preset.label}</dd>
                  <dt>Agents</dt>
                  <dd>{agents.map((agent) => agent.role).join(", ")}</dd>
                  <dt>Constraints</dt>
                  <dd>{constraintList.length}</dd>
                  <dt>Controller</dt>
                  <dd>{health?.llm_model ?? "Not detected"}</dd>
                </dl>
              </section>
            </div>
          )}

          {err && (
            <div className="mt-4 text-danger text-[11px] bg-danger/10 border border-danger/40 rounded-lg px-3 py-2">
              {err}
            </div>
          )}
        </div>

        <footer className="flex items-center gap-2 px-5 py-3 border-t border-line bg-ink-900">
          <span className="text-[10px] text-muted">
            Step {step + 1} of {STEPS.length}
          </span>
          <div className="ml-auto flex gap-2">
            {step > 0 && (
              <button
                onClick={() => {
                  setErr(null);
                  setStep((current) => current - 1);
                }}
                className="secondary-button"
              >
                Back
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button onClick={next} className="primary-button">
                Continue
              </button>
            ) : (
              <button
                onClick={create}
                disabled={busy || !online || !systemPreflight?.ready}
                className="primary-button disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy ? "Starting..." : "Create and start"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

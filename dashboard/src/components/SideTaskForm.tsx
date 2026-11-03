import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api";
import { ROLE_HELP, ROLE_OPTIONS, roleLabel } from "@/lib/format";
import type { AgentCliInfo } from "@/lib/types";
import { Icon } from "./ui";

/** Launches an auxiliary agent alongside the pipeline. */
export function SideTaskForm({
  sid,
  clis,
  defaultCli,
  onLaunched,
}: {
  sid: string;
  clis: AgentCliInfo[];
  defaultCli: string;
  onLaunched: (aid: string) => void;
}) {
  const [aid, setAid] = useState("");
  const [role, setRole] = useState("experiment-executor");
  const [cli, setCli] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const chosen = clis.find((c) => c.name === (cli || defaultCli));
  const idOk = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(aid.trim());

  const launch = async () => {
    if (!idOk || !prompt.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await apiClient.launchAuxiliary(sid, {
        agent_id: aid.trim(),
        role,
        prompt: prompt.trim(),
        model: model.trim() || null,
        ...(cli ? { agent_cli: cli } : {}),
      });
      onLaunched(aid.trim());
      setAid("");
      setPrompt("");
      setModel("");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-grid">
      <label className="field">
        <span className="field-label">Task name</span>
        <input
          value={aid}
          onChange={(e) => setAid(e.target.value)}
          placeholder="e.g. tokenizer-check"
          className="mono"
          aria-invalid={!!aid && !idOk}
        />
        <span className="field-help">Letters, digits, dots, dashes. Becomes the agent id.</span>
      </label>
      <label className="field">
        <span className="field-label">Role</span>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
        <span className="field-help">{ROLE_HELP[role]}</span>
      </label>
      <label className="field">
        <span className="field-label">Agent CLI</span>
        <select value={cli} onChange={(e) => setCli(e.target.value)}>
          <option value="">Run default ({clis.find((c) => c.name === defaultCli)?.display_name ?? defaultCli})</option>
          {clis.map((c) => (
            <option key={c.name} value={c.name} disabled={!c.installed}>
              {c.display_name}
              {c.installed ? "" : " (not installed)"}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Model (optional)</span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={chosen?.default_model ?? chosen?.model_hint ?? "CLI default"}
          className="mono"
        />
        {chosen?.model_hint && <span className="field-help">{chosen.model_hint}</span>}
      </label>
      <label className="field span-all">
        <span className="field-label">What should it do?</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder="Describe the task and how the agent knows it is finished."
        />
      </label>
      <div className="span-all action-row">
        <button className="btn btn-primary" disabled={busy || !idOk || !prompt.trim()} onClick={launch}>
          <Icon name="play" /> {busy ? "Starting…" : "Start side task"}
        </button>
        {err && <span className="inline-error">{err}</span>}
      </div>
    </div>
  );
}

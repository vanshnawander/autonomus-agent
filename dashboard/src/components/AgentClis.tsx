import type { AgentCliInfo } from "@/lib/types";
import { Chip } from "./ui";

function capabilityList(cli: AgentCliInfo): { label: string; on: boolean; title: string }[] {
  const c = cli.capabilities ?? { resume: false, trace_export: false, session_id_capture: false, model_selection: false };
  return [
    { label: "Resume after restart", on: !!c.resume, title: "Can continue an interrupted agent conversation" },
    { label: "Choose model", on: !!c.model_selection, title: "Accepts a per-agent model override" },
    { label: "Session id capture", on: !!c.session_id_capture, title: "Records its session id so it can be resumed" },
    { label: "Trace export", on: !!c.trace_export, title: "Exports a full trace of the agent conversation" },
  ];
}

/** One agent CLI. Selectable (radio) in the wizard, static on the home page. */
export function CliCard({
  cli,
  isDefault,
  selected,
  onSelect,
  name,
}: {
  cli: AgentCliInfo;
  isDefault?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  /** radio group name when selectable */
  name?: string;
}) {
  const body = (
    <>
      <div className="cli-card-head">
        <strong>{cli.display_name}</strong>
        {cli.installed ? <Chip tone="ok">Installed</Chip> : <Chip tone="bad">Not installed</Chip>}
        {isDefault && <Chip tone="info">Server default</Chip>}
      </div>
      {cli.description && <p className="cli-card-desc">{cli.description}</p>}
      <dl className="cli-card-facts">
        <dt>Command</dt>
        <dd>
          <code>{cli.command}</code>
        </dd>
        <dt>Default model</dt>
        <dd>{cli.default_model || <span className="muted">CLI default</span>}</dd>
      </dl>
      <ul className="cap-list">
        {capabilityList(cli).map((cap) => (
          <li key={cap.label} className={cap.on ? "is-on" : "is-off"} title={cap.title}>
            <span aria-hidden="true">{cap.on ? "✓" : "–"}</span>
            {cap.label}
            <span className="sr-only">{cap.on ? " supported" : " not supported"}</span>
          </li>
        ))}
      </ul>
      {cli.notes && <p className="cli-card-notes">{cli.notes}</p>}
      {!cli.installed && onSelect && (
        <p className="cli-card-warn">Install it first so <code>{cli.command}</code> is on the server's PATH.</p>
      )}
    </>
  );

  if (!onSelect) return <div className="cli-card">{body}</div>;
  return (
    <label className={`cli-card is-selectable ${selected ? "is-selected" : ""} ${cli.installed ? "" : "is-disabled"}`}>
      <input
        type="radio"
        name={name}
        className="sr-only"
        checked={!!selected}
        disabled={!cli.installed}
        onChange={onSelect}
      />
      {body}
    </label>
  );
}

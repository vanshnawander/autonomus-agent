import { Link } from "react-router-dom";
import { agentStatusLabel, agentStatusTone, roleLabel } from "@/lib/format";
import type { AgentStateResponse } from "@/lib/types";
import { Chip, CliBadge, Icon } from "./ui";

/** One row per agent: who it is, what runs it, and its state. */
export function AgentList({
  sid,
  agents,
  currentStageAgent,
  onShowTerminal,
}: {
  sid: string;
  agents: AgentStateResponse[];
  currentStageAgent?: string | null;
  onShowTerminal: (aid: string) => void;
}) {
  if (!agents.length) return <p className="muted">No agents in this run.</p>;
  return (
    <ul className="agent-list">
      {agents.map((agent) => {
        const attempts = agent.attempt_count ?? 0;
        const isCurrent = currentStageAgent === agent.agent_id;
        return (
          <li key={agent.agent_id} className={`agent-row ${isCurrent ? "is-current" : ""}`}>
            <div className="agent-row-main">
              <span className="agent-row-role">
                {agent.kind === "auxiliary" ? "Side task · " : ""}
                {roleLabel(agent.role)}
                {isCurrent && <span className="agent-row-current">Current stage</span>}
              </span>
              <span className="agent-row-meta">
                <code>{agent.agent_id}</code>
                <CliBadge cli={agent.agent_cli} />
                {agent.model && <span>{agent.model}</span>}
                {attempts > 0 && <span>{attempts === 1 ? "1 attempt" : `${attempts} attempts`}</span>}
              </span>
            </div>
            <Chip tone={agentStatusTone(agent)} dot={agent.alive}>
              {agentStatusLabel(agent)}
            </Chip>
            <div className="agent-row-actions">
              <button className="btn btn-sm" onClick={() => onShowTerminal(agent.agent_id)}>
                <Icon name="terminal" /> Terminal
              </button>
              <Link className="btn btn-sm btn-ghost" to={`/sessions/${sid}/agents/${agent.agent_id}`}>
                Details <Icon name="chevron" />
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

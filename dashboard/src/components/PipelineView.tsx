import type { AgentStateResponse, AgentStatus } from "@/lib/types";

const WORK_STAGES = [
  "literature-survey",
  "methodology",
  "experiment-executor",
  "paper-writer",
];

export function inferPipeline(agents: Record<string, AgentStateResponse>): string[] {
  const roles = new Set(Object.values(agents).map((agent) => agent.role));
  const hasReviewer = roles.has("reviewer");
  const pipeline: string[] = [];
  for (const stage of WORK_STAGES) {
    if (roles.has(stage)) {
      pipeline.push(stage);
      if (hasReviewer) pipeline.push("reviewer");
    }
  }
  return pipeline.length ? pipeline : Array.from(roles);
}

export function PipelineView({
  agents,
  activeAgent,
  pipeline: serverPipeline,
  stageIndex,
}: {
  agents: Record<string, AgentStateResponse>;
  activeAgent?: string | null;
  pipeline?: string[];
  stageIndex?: number;
}) {
  const hasServerState = !!serverPipeline?.length && stageIndex !== undefined;
  const pipeline = serverPipeline?.length ? serverPipeline : inferPipeline(agents);
  if (!pipeline.length) return <span className="text-muted text-xs">No pipeline</span>;

  const roleStatus: Record<string, AgentStatus> = {};
  for (const agent of Object.values(agents)) {
    roleStatus[agent.role] = agent.status;
  }

  let activeIndex = hasServerState ? stageIndex : -1;
  if (!hasServerState && activeAgent && agents[activeAgent]) {
    activeIndex = pipeline.lastIndexOf(agents[activeAgent].role);
  }

  let reviewerNumber = 0;
  return (
    <ol className="pipeline-track">
      {pipeline.map((stage, index) => {
        if (stage === "reviewer") reviewerNumber += 1;
        const isDone =
          activeIndex >= pipeline.length ||
          (activeIndex >= 0 && index < activeIndex) ||
          (!hasServerState && roleStatus[stage] === "done");
        const isActive = index === activeIndex;
        const status = roleStatus[stage];
        const isError = isActive && status === "error";
        const isRunning =
          isActive && (status === "running" || status === "waiting");
        const className = isError
          ? "pipeline-stage pipeline-error"
          : isDone
            ? "pipeline-stage pipeline-done"
            : isActive
              ? "pipeline-stage pipeline-active"
              : "pipeline-stage";

        return (
          <li key={`${stage}-${index}`} className="pipeline-item">
            <span className={className}>
              <span className="pipeline-index">{index + 1}</span>
              {stage === "reviewer" ? `reviewer gate ${reviewerNumber}` : stage}
              {isRunning && <span className="status-dot status-ok pulse-soft" />}
            </span>
            {index < pipeline.length - 1 && (
              <span className={`pipeline-connector ${isDone ? "complete" : ""}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

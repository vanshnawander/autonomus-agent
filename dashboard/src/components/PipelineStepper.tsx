import type { PipelineGroup, PipelineStep, StepState } from "@/lib/pipeline";
import { Icon } from "./ui";

const STATE_LABEL: Record<StepState, string> = {
  done: "Done",
  active: "In progress",
  stopped: "Stopped here",
  error: "Failed here",
  pending: "Not started",
};

const STATE_ICON: Record<StepState, "check" | "play" | "pause" | "cross" | "dot"> = {
  done: "check",
  active: "play",
  stopped: "pause",
  error: "cross",
  pending: "dot",
};

function StepRow({ step, isGate }: { step: PipelineStep; isGate: boolean }) {
  return (
    <li className={`step step-${step.state}`}>
      <span className="step-icon" aria-hidden="true">
        <Icon name={STATE_ICON[step.state]} />
      </span>
      <div className="step-body">
        <div className="step-line">
          <span className="step-label">{isGate ? step.label : "Work"}</span>
          <span className="step-state">{STATE_LABEL[step.state]}</span>
        </div>
        {step.rejections > 0 && (
          <span className="step-reject" title={step.lastReason ? `Latest reason: ${step.lastReason}` : undefined}>
            <Icon name="retry" />
            {isGate ? `Rejected ${step.rejections}×` : `Sent back ${step.rejections}×`}
          </span>
        )}
      </div>
    </li>
  );
}

/** Work stages as columns, each followed by its critic and acceptance gates. */
export function PipelineStepper({ groups }: { groups: PipelineGroup[] }) {
  if (!groups.length) return <p className="muted">No pipeline recorded for this run.</p>;
  return (
    <ol className="stepper">
      {groups.map((group, gi) => (
        <li key={`${group.role}-${gi}`} className={`stage-group group-${group.state}`}>
          <div className="stage-head">
            <span className="stage-num">{gi + 1}</span>
            <span className="stage-title">{group.label}</span>
          </div>
          <ol className="steps">
            {group.steps.map((step, si) => (
              <StepRow key={step.index} step={step} isGate={si > 0 || group.role === "critic" || group.role === "reviewer"} />
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

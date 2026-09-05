import type { AgentSpec } from "./types";

export interface ResearchPreset {
  id: string;
  label: string;
  description: string;
  goal: string;
  constraints: string[];
  agents: AgentSpec[];
}

const DEFAULT_AGENTS: AgentSpec[] = [
  { agent_id: "survey", role: "literature-survey" },
  { agent_id: "research-critic", role: "critic" },
  { agent_id: "strict-reviewer", role: "reviewer" },
  { agent_id: "methodology", role: "methodology" },
  { agent_id: "experimenter", role: "experiment-executor" },
  { agent_id: "writer", role: "paper-writer" },
];

export const PRESETS: ResearchPreset[] = [
  {
    id: "full-pipeline",
    label: "Full Research Pipeline",
    description:
      "Literature → critic → reviewer → methodology → experiments → paper. Two independent quality gates per stage.",
    goal:
      "Survey recent work on the chosen topic, identify open problems, design a minimal reproducible methodology, run experiments, and write an evidence-grounded paper draft.",
    constraints: [
      "Use primary sources; record every repo remote, license and commit SHA.",
      "Do not fabricate citations, results, or completed runs.",
      "Run cheap smoke tests before substantive experiments.",
      "Use local SearXNG for every discovery query and retain the ledger.",
      "The critic must reject weak or derivative ideas before reviewer acceptance.",
      "Reviewer approval is exceptional and requires independent verification.",
    ],
    agents: DEFAULT_AGENTS,
  },
  {
    id: "lit-survey-only",
    label: "Literature Survey Only",
    description:
      "Survey, adversarial idea critique, and independent acceptance review before experiments.",
    goal:
      "Survey recent work on the chosen topic, produce per-paper summaries, and compile a ranked list of open, experimentally testable problems.",
    constraints: [
      "Use primary sources.",
      "One structured summary file per included paper.",
      "Do not fabricate citations.",
    ],
    agents: [
      { agent_id: "survey", role: "literature-survey" },
      { agent_id: "critic", role: "critic" },
      { agent_id: "reviewer", role: "reviewer" },
    ],
  },
  {
    id: "experiments-only",
    label: "Experiments + Paper",
    description:
      "Skip the survey; go straight to methodology, experiments, and writing.",
    goal:
      "Design and run the experiments for the chosen hypothesis, then write a paper draft with figures and results.",
    constraints: [
      "Keep experiment code modular with tests and immutable results.",
      "Retain failed/null results.",
      "Generate at least 3 figures.",
    ],
    agents: [
      { agent_id: "methodology", role: "methodology" },
      { agent_id: "experimenter", role: "experiment-executor" },
      { agent_id: "critic", role: "critic" },
      { agent_id: "writer", role: "paper-writer" },
      { agent_id: "reviewer", role: "reviewer" },
    ],
  },
];

/** Suggest a unique session id from a topic string + timestamp. */
export function suggestSessionId(topic: string): string {
  const base = (topic || "research")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const stamp = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 5);
  return `${base || "research"}-${stamp}-${rand}`;
}

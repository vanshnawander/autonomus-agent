// Labels and one-line fix hints for /preflight checks.
import { cliLabel } from "./format";
import type { PreflightResponse } from "./types";

interface CheckMeta {
  label: string;
  hint: string;
}

const CHECKS: Record<string, CheckMeta> = {
  controller: {
    label: "Controller LLM",
    hint: "Add OPENROUTER_API_KEY to .env and restart the orchestrator.",
  },
  devin: {
    label: "Devin CLI",
    hint: "Install the Devin CLI so the `devin` command is on PATH.",
  },
  python: {
    label: "Python interpreter",
    hint: "Point DEVIN_ORCH_PYTHON at the research-agents environment's python.",
  },
  conda: {
    label: "Conda environment",
    hint: "Start the orchestrator with `conda run -n research-agents …` (or set DEVIN_ORCH_CONDA_ENV).",
  },
  workspace: {
    label: "Workspace folder",
    hint: "Create the runs/ folder or set DEVIN_ORCH_WORKSPACE_ROOT to a writable directory.",
  },
  trace_export: {
    label: "Trace export",
    hint: "Set DEVIN_ORCH_EXPORT_TRACES=true so interrupted agents can be resumed.",
  },
  searxng: {
    label: "Local web search (SearXNG)",
    hint: "Start SearXNG at SEARXNG_URL (default http://127.0.0.1:8080).",
  },
  server_inventory: {
    label: "Remote experiment servers",
    hint: "Fix servers.json (DEVIN_ORCH_SERVERS_FILE), or remove it to run locally. Password login needs sshpass or pexpect.",
  },
};

function metaFor(name: string, detail: string): CheckMeta {
  if (name.startsWith("cli:")) {
    const cli = name.slice(4);
    return {
      label: `${cliLabel(cli)} CLI`,
      hint: `Install ${cliLabel(cli)} so \`${detail.replace(/\s*\(default\)\s*$/, "") || cli}\` is on PATH, or choose a different agent CLI.`,
    };
  }
  return CHECKS[name] ?? { label: name.replace(/[_:]+/g, " "), hint: "See docs/OPERATIONS.md." };
}

export interface CheckRow {
  name: string;
  label: string;
  hint: string;
  detail: string;
  ok: boolean;
  optional: boolean;
}

/** Normalises preflight checks. Agent CLIs other than the default are optional. */
export function checkRows(preflight: PreflightResponse | null | undefined, defaultCli: string): CheckRow[] {
  return Object.entries(preflight?.checks ?? {}).map(([name, check]) => {
    const meta = metaFor(name, check.detail);
    const isCli = name.startsWith("cli:");
    return {
      name,
      label: meta.label,
      hint: meta.hint,
      detail: check.detail,
      ok: check.ok,
      optional: isCli && name !== `cli:${defaultCli}`,
    };
  });
}


import { FALLBACK_CLIS } from "./format";
import type { AgentCliInfo, AgentClisResponse, HealthResponse, PreflightResponse } from "./types";

export interface ResolvedClis {
  defaultCli: string;
  clis: AgentCliInfo[];
  /** True when the server doesn't expose /agent-clis (older orchestrator). */
  legacy: boolean;
}

/** Uses /agent-clis when available, otherwise reconstructs the list from
 * /health and /preflight so older servers still render something useful. */
export function resolveClis(
  data: AgentClisResponse | null | undefined,
  preflight?: PreflightResponse | null,
  health?: HealthResponse | null,
): ResolvedClis {
  if (data?.clis?.length) {
    return { defaultCli: data.default || data.clis[0].name, clis: data.clis, legacy: false };
  }
  const checks = preflight?.checks ?? {};
  const clis = FALLBACK_CLIS.map((cli) => {
    const installed =
      health?.agent_clis?.[cli.name] ??
      checks[`cli:${cli.name}`]?.ok ??
      (cli.name === "devin" ? checks.devin?.ok : undefined) ??
      false;
    const isLegacyDevin = cli.name === "devin" && !health?.agent_clis;
    return {
      ...cli,
      installed,
      command: isLegacyDevin ? (health?.devin_command ?? cli.command) : cli.command,
      default_model: isLegacyDevin ? (health?.devin_model ?? null) : cli.default_model,
    };
  });
  const legacyOnlyDevin = !health?.agent_clis && !Object.keys(checks).some((k) => k.startsWith("cli:"));
  return {
    defaultCli: health?.default_agent_cli ?? "devin",
    clis: legacyOnlyDevin ? clis.filter((c) => c.name === "devin") : clis,
    legacy: true,
  };
}

import { useCallback, useEffect, useState } from "react";
import { apiClient, errorMessage, isNotFound, openEventStream, openLiveTerminal } from "@/lib/api";
import type {
  AgentStateResponse,
  ApprovalItem,
  Event,
  HealthResponse,
  SessionResponse,
  SessionSummary,
} from "@/lib/types";

/** Polls /health on an interval. */
export function useHealth(intervalMs = 5000) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [online, setOnline] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await apiClient.health();
        if (alive) {
          setHealth(h);
          setOnline(true);
        }
      } catch {
        if (alive) setOnline(false);
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);
  return { health, online };
}

/** Polls the unified (live + recorded) session list for the sidebar. */
export function useAllSessions(intervalMs = 5000) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const list = await apiClient.listAllSessions();
        if (alive) {
          setSessions(list);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);
  return { sessions, error };
}

/** Polls pending approvals across live sessions so review requests are visible globally. */
export function usePendingApprovals(sessions: SessionSummary[], intervalMs = 2500) {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sessionIds = sessions
    .filter((session) => session.live && !session.done)
    .map((session) => session.session_id)
    .sort()
    .join("\u0000");
  useEffect(() => {
    let alive = true;
    const ids = sessionIds ? sessionIds.split("\u0000") : [];
    const tick = async () => {
      if (!ids.length) {
        if (alive) {
          setItems([]);
          setError(null);
        }
        return;
      }
      try {
        const approvals = (await Promise.all(ids.map((sid) => apiClient.listApprovals(sid)))).flat();
        if (alive) {
          setItems(approvals);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [sessionIds, intervalMs]);
  return { approvals: items, error };
}

/** Polls a single session's full state (with agents) on an interval.
 *
 * If the live session 404s (e.g. the orchestrator restarted and the session
 * only exists on disk), falls back to the recorded manifest from /logs/{sid}
 * and synthesizes a SessionResponse so the dashboard can still render past
 * runs. The synthesized agents have status "idle" (we don't know live state).
 */
export function useSession(sid: string | null, intervalMs = 2500) {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!sid) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await apiClient.getSession(sid);
        if (alive) {
          setSession({ ...s, live: true });
          setError(null);
        }
      } catch (e) {
        if (isNotFound(e)) {
          // Fall back to recorded session manifest.
          try {
            const rec = await apiClient.getRecordedSession(sid);
            const manifest = rec.manifest as {
              goal?: string;
              agents?: Record<string, { role?: string; agent_cli?: string; model?: string }>;
              done?: boolean;
              pipeline?: string[];
              stage_index?: number;
              approval_mode?: "manual" | "autonomous";
              workspace?: string;
              agent_cli?: string;
            };
            const agents: Record<string, AgentStateResponse> = {};
            for (const [aid, info] of Object.entries(manifest.agents ?? {})) {
              agents[aid] = {
                agent_id: aid,
                role: info?.role ?? "unknown",
                status: "idle",
                visible_screen: "",
                recent_output: "",
                last_decision: null,
                devin_session_id: null,
                pending_approval: null,
                agent_cli: info?.agent_cli ?? manifest.agent_cli ?? null,
                model: info?.model ?? null,
                alive: false,
              };
            }
            if (alive) {
              setSession({
                session_id: sid,
                goal: manifest.goal ?? "",
                agents,
                active_agent: null,
                done: !!manifest.done,
                live: false,
                pipeline: manifest.pipeline,
                stage_index: manifest.stage_index,
                approval_mode: manifest.approval_mode,
                workspace: manifest.workspace,
                agent_cli: manifest.agent_cli ?? null,
              });
              setError(null);
            }
            return;
          } catch {
            /* fall through to set error */
          }
        }
        if (alive) setError(errorMessage(e));
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [sid, intervalMs, nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { session: session?.session_id === sid ? session : null, error, refresh };
}

const MAX_EVENTS = 600;
const MAX_TERMINAL_EVENTS = 150;

/** Keeps the newest events, dropping noisy terminal_output first so the
 * meaningful lifecycle events survive long runs. */
function trimEvents(events: Event[]): Event[] {
  if (events.length <= MAX_EVENTS) return events;
  let terminal = events.reduce((n, e) => n + (e.type === "terminal_output" ? 1 : 0), 0);
  let excess = events.length - MAX_EVENTS;
  const out: Event[] = [];
  for (const e of events) {
    if (excess > 0 && e.type === "terminal_output" && terminal > MAX_TERMINAL_EVENTS) {
      terminal -= 1;
      excess -= 1;
      continue;
    }
    out.push(e);
  }
  return out.length > MAX_EVENTS ? out.slice(-MAX_EVENTS) : out;
}

/** Subscribes to the session SSE event stream; returns the accumulated events. */
export function useSessionEvents(sid: string | null) {
  // Events are stored with the sid they belong to so switching sessions never
  // shows the previous session's events (no reset needed inside the effect).
  const [state, setState] = useState<{ sid: string | null; events: Event[] }>({ sid: null, events: [] });
  const [connection, setConnection] = useState<"connecting" | "connected" | "retrying">("connecting");
  useEffect(() => {
    if (!sid) return;
    const seen = new Set<string>();
    let buffer: Event[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Batch bursts (the server replays history on connect) into one render.
    const flush = () => {
      timer = null;
      const batch = buffer;
      buffer = [];
      setState((prev) => ({
        sid,
        events: trimEvents(prev.sid === sid ? [...prev.events, ...batch] : batch),
      }));
    };
    const close = openEventStream(sid, (e) => {
      if (e.event_id && seen.has(e.event_id)) return;
      if (e.event_id) {
        seen.add(e.event_id);
        if (seen.size > 4000) seen.delete(seen.values().next().value!);
      }
      buffer.push(e);
      if (!timer) timer = setTimeout(flush, 150);
    }, setConnection);
    return () => {
      if (timer) clearTimeout(timer);
      close();
    };
  }, [sid]);
  return { events: state.sid === sid ? state.events : [], connection };
}

/** Subscribes to one agent's live terminal screen; returns the latest text. */
export function useLiveTerminal(sid: string | null, aid: string | null, active: boolean) {
  const key = sid && aid ? `${sid}/${aid}` : null;
  const [state, setState] = useState<{ key: string | null; text: string }>({ key: null, text: "" });
  useEffect(() => {
    if (!sid || !aid || !active) return;
    const streamKey = `${sid}/${aid}`;
    let revision = -1;
    let close: (() => void) | null = null;
    close = openLiveTerminal(
      sid,
      aid,
      (data, mode, rev) => {
        if (rev !== undefined && mode === "replace" && rev <= revision) return;
        if (rev !== undefined) revision = rev;
        setState((prev) => {
          const base = prev.key === streamKey && mode === "append" ? prev.text : "";
          const next = base + data;
          return { key: streamKey, text: next.length > 16000 ? next.slice(-16000) : next };
        });
      },
      () => close?.(),
    );
    return () => close?.();
  }, [sid, aid, active]);
  return state.key === key ? state.text : "";
}

/** Generic async fetch hook with refresh. */
function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  intervalMs?: number,
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      setLoading(true);
      try {
        const d = await fetcher();
        if (alive) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(errorMessage(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    run();
    const id = intervalMs ? setInterval(run, intervalMs) : null;
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, intervalMs]);
  return { data, error, loading, refresh: () => setTick((t) => t + 1) };
}

export function useAgentAttempts(sid: string, aid: string) {
  return useAsync(() => apiClient.listAgentAttempts(sid, aid), [sid, aid], 5000);
}

export function useAgentRaw(sid: string, aid: string, attemptId?: string, tailBytes?: number) {
  return useAsync(
    () => apiClient.getAgentRaw(sid, aid, attemptId, tailBytes),
    [sid, aid, attemptId, tailBytes],
  );
}

export function useAgentAudit(sid: string, aid: string, tail = 100, attemptId?: string) {
  return useAsync(
    () => apiClient.getAgentAudit(sid, aid, tail, attemptId),
    [sid, aid, tail, attemptId],
    5000,
  );
}

export function useAgentController(sid: string, aid: string, tail = 50, attemptId?: string) {
  return useAsync(
    () => apiClient.getAgentController(sid, aid, tail, attemptId),
    [sid, aid, tail, attemptId],
    5000,
  );
}

export function useAgentScreens(sid: string, aid: string, tail = 50, attemptId?: string) {
  return useAsync(
    () => apiClient.getAgentScreens(sid, aid, tail, attemptId),
    [sid, aid, tail, attemptId],
  );
}

export function useAgentFeedback(sid: string, aid: string, attemptId?: string) {
  return useAsync(
    () => apiClient.getAgentFeedback(sid, aid, attemptId),
    [sid, aid, attemptId],
    5000,
  );
}

export function useAgentSummary(sid: string, aid: string, attemptId?: string) {
  return useAsync(
    () => apiClient.getAgentSummary(sid, aid, attemptId),
    [sid, aid, attemptId],
    5000,
  );
}

export function useRecordedSession(sid: string) {
  return useAsync(() => apiClient.getRecordedSession(sid), [sid], 10000);
}

/** Loads recorded events from /logs/{sid}/events (polled). */
export function useRecordedEvents(sid: string | null, tail = 200) {
  return useAsync(
    async () => (sid ? apiClient.recordedEvents(sid, tail) : []),
    [sid, tail],
    10000,
  );
}

export function useHandoffs(sid: string) {
  return useAsync(() => apiClient.listHandoffs(sid), [sid], 5000);
}

export function useApprovals(sid: string) {
  return useAsync(() => apiClient.listApprovals(sid), [sid], 2500);
}

export function usePreflight() {
  return useAsync(() => apiClient.preflight(), [], 30000);
}

/** Installed agent CLIs. `data` is null on servers without /agent-clis. */
export function useAgentClis() {
  return useAsync(
    async () => {
      try {
        return await apiClient.agentClis();
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    [],
    30000,
  );
}

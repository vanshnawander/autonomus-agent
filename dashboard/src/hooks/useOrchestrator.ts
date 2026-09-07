import { useEffect, useRef, useState } from "react";
import { apiClient, openEventStream, openGlobalEventStream, openLiveTerminal } from "@/lib/api";
import type { ApprovalItem, Event, HealthResponse, SessionResponse, SessionSummary } from "@/lib/types";

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

/** Polls the session list on an interval. */
export function useSessionList(intervalMs = 5000) {
  const [sessions, setSessions] = useState<SessionResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const list = await apiClient.listSessions();
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
  useEffect(() => {
    if (!sid) {
      setSession(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const s = await apiClient.getSession(sid);
        if (alive) {
          setSession({ ...s, live: true });
          setError(null);
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.startsWith("404")) {
          // Fall back to recorded session manifest.
          try {
            const rec = await apiClient.getRecordedSession(sid);
            const manifest = rec.manifest as {
              goal?: string;
              agents?: Record<string, { role?: string }>;
              done?: boolean;
            };
            const agents: Record<string, import("@/lib/types").AgentStateResponse> = {};
            const ma = manifest.agents ?? {};
            for (const [aid, info] of Object.entries(ma)) {
              agents[aid] = {
                agent_id: aid,
                role: info?.role ?? "unknown",
                status: "idle",
                visible_screen: "",
                recent_output: "",
                last_decision: null,
                devin_session_id: null,
                pending_approval: null,
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
              });
              setError(null);
            }
            return;
          } catch {
            /* fall through to set error */
          }
        }
        if (alive) setError(msg);
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [sid, intervalMs]);
  return { session, error };
}

/** Subscribes to the session SSE event stream; returns the accumulated events. */
export function useSessionEvents(sid: string | null) {
  const [events, setEvents] = useState<Event[]>([]);
  const [connection, setConnection] = useState<"connecting" | "connected" | "retrying">("connecting");
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!sid) return;
    setEvents([]);
    seen.current.clear();
    const close = openEventStream(sid, (e) => {
      if (e.event_id && seen.current.has(e.event_id)) return;
      if (e.event_id) {
        seen.current.add(e.event_id);
        if (seen.current.size > 1000) seen.current.delete(seen.current.values().next().value!);
      }
      setEvents((prev) => {
        const next = [...prev, e];
        return next.length > 300 ? next.slice(-300) : next;
      });
    }, setConnection);
    return close;
  }, [sid]);
  return { events, connection };
}

/** Subscribes to the global SSE stream (all sessions + heartbeats). */
export function useGlobalEvents() {
  const [events, setEvents] = useState<Event[]>([]);
  useEffect(() => {
    const close = openGlobalEventStream((e) => {
      setEvents((prev) => {
        if (e.type === "heartbeat") {
          // Keep only the latest heartbeat.
          const without = prev.filter((p) => p.type !== "heartbeat");
          const next = [...without, e];
          return next.length > 400 ? next.slice(-400) : next;
        }
        const next = [...prev, e];
        return next.length > 400 ? next.slice(-400) : next;
      });
    });
    return close;
  }, []);
  return events;
}

/** Subscribes to one agent's live PTY output stream; returns the buffered text. */
export function useLiveTerminal(sid: string | null, aid: string | null, active: boolean) {
  const [buffer, setBuffer] = useState("");
  const closeRef = useRef<(() => void) | null>(null);
  const revisionRef = useRef(-1);
  useEffect(() => {
    closeRef.current?.();
    closeRef.current = null;
    if (!sid || !aid || !active) {
      return;
    }
    revisionRef.current = -1;
    setBuffer("");
    const close = openLiveTerminal(
      sid,
      aid,
      (data, mode, revision) => {
        if (
          revision !== undefined &&
          mode === "replace" &&
          revision <= revisionRef.current
        ) {
          return;
        }
        if (revision !== undefined) revisionRef.current = revision;
        setBuffer((prev) => {
          const next = mode === "replace" ? data : prev + data;
          return next.length > 16000 ? next.slice(-16000) : next;
        });
      },
      () => closeRef.current?.(),
    );
    closeRef.current = close;
    return () => {
      close();
    };
  }, [sid, aid, active]);
  return buffer;
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
        if (alive) setError((e as Error).message);
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

/** Loads recorded events from /logs/{sid}/events (one-shot, with refresh). */
export function useRecordedEvents(sid: string | null, tail = 200) {
  return useAsync(
    async () => {
      if (!sid) return [];
      const q = new URLSearchParams({ tail: String(tail) });
      const res = await fetch(`/logs/${encodeURIComponent(sid)}/events?${q}`);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return (await res.json()) as Event[];
    },
    [sid, tail],
    10000,
  );
}

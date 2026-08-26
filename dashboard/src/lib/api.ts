// Thin fetch wrapper for the orchestrator REST API.
import type {
  ApprovalItem,
  AgentAttempt,
  AuditEntry,
  ControllerEntry,
  CreateSessionRequest,
  Event,
  FeedbackEntry,
  HandoffRecord,
  HealthResponse,
  PreflightResponse,
  RawLogResponse,
  RecordedSession,
  ScreenSnapshot,
  SessionResponse,
  SessionSummary,
  AgentSummary,
} from "./types";

// Base URL for the orchestrator API. Empty string means "same origin" which
// works when the dashboard is served by FastAPI (prod) or via the Vite proxy
// (dev). Allow an explicit override via Vite env or window.__API_BASE__ for
// pointing the dashboard at a remote orchestrator.
const BASE: string =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE ??
  (globalThis as unknown as { __API_BASE__?: string }).__API_BASE__ ??
  "";

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return res.status === 204 ? (null as T) : ((await res.json()) as T);
}

export const apiClient = {
  health: () => api<HealthResponse>("/health"),
  preflight: () => api<PreflightResponse>("/preflight"),
  listSessions: () => api<SessionResponse[]>("/sessions"),
  listAllSessions: () => api<SessionSummary[]>("/sessions/all"),
  getSession: (sid: string) =>
    api<SessionResponse>(`/sessions/${encodeURIComponent(sid)}`),
  createSession: (req: CreateSessionRequest) =>
    api<SessionResponse>("/sessions", {
      method: "POST",
      body: JSON.stringify(req),
    }),
  deleteSession: (sid: string) =>
    api<{ deleted: string }>(`/sessions/${encodeURIComponent(sid)}`, {
      method: "DELETE",
    }),
  resumeSession: (sid: string, freshIfMissing = true) =>
    api<SessionResponse>(
      `/sessions/${encodeURIComponent(sid)}/resume?fresh_if_missing=${freshIfMissing}`,
      { method: "POST" },
    ),
  sendFeedback: (
    sid: string,
    message: string,
    target_agent: string,
    mode: "immediate" | "context" | "interrupt",
  ) =>
    api<{ target_agent: string; mode: string }>(
      `/sessions/${encodeURIComponent(sid)}/feedback`,
      { method: "POST", body: JSON.stringify({ message, target_agent, mode }) },
    ),
  forceInput: (
    sid: string,
    aid: string,
    body: { type: string; text?: string | null; key?: string | null },
  ) =>
    api<{ agent_id: string; action: string }>(
      `/sessions/${encodeURIComponent(sid)}/agents/${encodeURIComponent(aid)}/input`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  restartAgent: (sid: string, aid: string, resume = true) =>
    api<{ agent_id: string; restarted: boolean; resume: boolean }>(
      `/sessions/${encodeURIComponent(sid)}/agents/${encodeURIComponent(aid)}/restart?resume=${resume}`,
      { method: "POST" },
    ),
  listApprovals: (sid: string) =>
    api<ApprovalItem[]>(`/sessions/${encodeURIComponent(sid)}/approvals`),
  resolveApproval: (sid: string, apid: string, approved: boolean, reason?: string) =>
    api<{ approval_id: string; approved: boolean }>(
      `/sessions/${encodeURIComponent(sid)}/approvals/${encodeURIComponent(apid)}`,
      { method: "POST", body: JSON.stringify({ approved, reason }) },
    ),
  listHandoffs: (sid: string) =>
    api<HandoffRecord[]>(`/logs/${encodeURIComponent(sid)}/handoffs`),

  // --- Recorded log artifacts (per agent / attempt) ---
  listRecordedSessions: () => api<RecordedSession[]>("/logs"),
  getRecordedSession: (sid: string) =>
    api<RecordedSession>(`/logs/${encodeURIComponent(sid)}`),
  listAgentAttempts: (sid: string, aid: string) =>
    api<AgentAttempt[]>(
      `/logs/${encodeURIComponent(sid)}/agents/${encodeURIComponent(aid)}/sessions`,
    ),
  getAgentRaw: (
    sid: string,
    aid: string,
    attemptId?: string,
    tailBytes?: number,
  ) => {
    const q = new URLSearchParams();
    if (attemptId) q.set("attempt_id", attemptId);
    if (tailBytes) q.set("tail_bytes", String(tailBytes));
    const qs = q.toString();
    return api<RawLogResponse>(
      `/logs/${encodeURIComponent(sid)}/agents/${encodeURIComponent(aid)}/raw${qs ? `?${qs}` : ""}`,
    );
  },
  getAgentAudit: (sid: string, aid: string, tail = 100, attemptId?: string) => {
    const q = new URLSearchParams({ tail: String(tail) });
    if (attemptId) q.set("attempt_id", attemptId);
    return api<AuditEntry[]>(
      `/logs/${encodeURIComponent(sid)}/agents/${encodeURIComponent(aid)}/audit?${q}`,
    ).then((entries) =>
      entries.map((entry): AuditEntry => ({
        ...entry,
        event: entry.event ?? entry.kind,
      })),
    );
  },
  getAgentScreens: (sid: string, aid: string, tail = 50, attemptId?: string) => {
    const q = new URLSearchParams({ tail: String(tail) });
    if (attemptId) q.set("attempt_id", attemptId);
    return api<ScreenSnapshot[]>(
      `/logs/${encodeURIComponent(sid)}/agents/${encodeURIComponent(aid)}/screens?${q}`,
    );
  },
  getAgentController: (sid: string, aid: string, tail = 50, attemptId?: string) => {
    const q = new URLSearchParams({ tail: String(tail) });
    if (attemptId) q.set("attempt_id", attemptId);
    return api<ControllerEntry[]>(
      `/logs/${encodeURIComponent(sid)}/agents/${encodeURIComponent(aid)}/controller?${q}`,
    ).then((entries) =>
      entries.map((entry): ControllerEntry => ({
        ...entry,
        decision: entry.decision ?? entry.response,
      })),
    );
  },
  getAgentFeedback: (sid: string, aid: string, attemptId?: string) => {
    const q = new URLSearchParams();
    if (attemptId) q.set("attempt_id", attemptId);
    return api<FeedbackEntry[]>(
      `/logs/${encodeURIComponent(sid)}/agents/${encodeURIComponent(aid)}/feedback${q.size ? `?${q}` : ""}`,
    );
  },
  getAgentSummary: (sid: string, aid: string, attemptId?: string) => {
    const q = new URLSearchParams();
    if (attemptId) q.set("attempt_id", attemptId);
    return api<AgentSummary>(
      `/logs/${encodeURIComponent(sid)}/agents/${encodeURIComponent(aid)}/summary${q.size ? `?${q}` : ""}`,
    );
  },
};

// SSE helpers — return an EventSource plus a cleanup function.
export function openEventStream(
  sid: string,
  onEvent: (e: Event) => void,
): () => void {
  const es = new EventSource(`${BASE}/sessions/${encodeURIComponent(sid)}/events`);
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as Event);
    } catch {
      /* ignore malformed */
    }
  };
  es.onerror = () => {
    /* EventSource auto-reconnects; nothing to do here. */
  };
  return () => es.close();
}

/** Global SSE stream of every event from every live session + heartbeats. */
export function openGlobalEventStream(onEvent: (e: Event) => void): () => void {
  const es = new EventSource(`${BASE}/events`);
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as Event);
    } catch {
      /* ignore malformed */
    }
  };
  es.onerror = () => {
    /* EventSource auto-reconnects; nothing to do here. */
  };
  return () => es.close();
}

export function openLiveTerminal(
  sid: string,
  aid: string,
  onFrame: (
    data: string,
    mode: "replace" | "append",
    revision?: number,
  ) => void,
  onEof?: () => void,
): () => void {
  const es = new EventSource(
    `${BASE}/logs/${encodeURIComponent(sid)}/agents/${encodeURIComponent(aid)}/live`,
  );
  es.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data) as {
        type: string;
        data?: string;
        revision?: number;
      };
      if (m.type === "screen" && typeof m.data === "string") {
        onFrame(m.data, "replace", m.revision);
      } else if (m.type === "output" && m.data) {
        onFrame(m.data, "append", m.revision);
      } else if (m.type === "eof") {
        onEof?.();
      }
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => {
    /* EventSource reconnects automatically. */
  };
  return () => es.close();
}

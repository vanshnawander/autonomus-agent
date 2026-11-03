import { createContext, useContext } from "react";
import type { ApprovalItem, HealthResponse, SessionSummary } from "./types";

/** Data the app shell already polls, shared so pages don't poll it twice. */
export interface AppData {
  health: HealthResponse | null;
  online: boolean;
  sessions: SessionSummary[];
  sessionsError: string | null;
  approvals: ApprovalItem[];
  approvalSessions: Set<string>;
  openWizard: (presetId?: string) => void;
}

export const AppContext = createContext<AppData>({
  health: null,
  online: false,
  sessions: [],
  sessionsError: null,
  approvals: [],
  approvalSessions: new Set(),
  openWizard: () => {},
});

export function useAppData() {
  return useContext(AppContext);
}

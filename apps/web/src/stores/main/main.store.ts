import { type OrchestrationEvent, ThreadId, type OrchestrationReadModel } from "@bigbud/contracts";
import { create } from "zustand";
import { type Project, type SidebarThreadSummary, type Thread } from "../../models/types";
import { applyOrchestrationEvent, applyOrchestrationEvents } from "./events.store";
import { syncServerReadModel } from "./helpers.store";
import {
  selectProjectById,
  selectIsThreadCompacting,
  selectSidebarThreadSummaryById,
  selectIsThreadRunning,
  selectThreadById,
  selectThreadIdsByProjectId,
  setError,
  setThreadBranch,
} from "./selectors.store";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  sidebarThreadsById: Record<string, SidebarThreadSummary>;
  threadIdsByProjectId: Record<string, ThreadId[]>;
  bootstrapComplete: boolean;
}

const initialState: AppState = {
  projects: [],
  threads: [],
  sidebarThreadsById: {},
  threadIdsByProjectId: {},
  bootstrapComplete: false,
};

// ── Re-exports for consumers ─────────────────────────────────────────

export {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  syncServerReadModel,
  selectProjectById,
  selectIsThreadCompacting,
  selectSidebarThreadSummaryById,
  selectIsThreadRunning,
  selectThreadById,
  selectThreadIdsByProjectId,
  setError,
  setThreadBranch,
};

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  applyOrchestrationEvent: (event: OrchestrationEvent) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...initialState,
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  applyOrchestrationEvent: (event) => set((state) => applyOrchestrationEvent(state, event)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
}));

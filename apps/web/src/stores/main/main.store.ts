import {
  type GetProjectThreadSummariesResult,
  type GetSelectedThreadDetailResult,
  type GetStartupProjectCatalogResult,
  type OrchestrationEvent,
  ThreadId,
  type ThreadMessageCursor,
  type ThreadSummaryCursor,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import type { GetSidebarThreadCatalogResult } from "@bigbud/contracts/orchestration/orchestration.catalog";
import { create } from "zustand";
import { type Project, type SidebarThreadSummary, type Thread } from "../../models/types";
import { applyOrchestrationEvent, applyOrchestrationEvents } from "./events.store";
import { syncServerReadModel } from "./helpers.snapshot.store";
import {
  setThreadHydration,
  appendProjectCatalogPage,
  appendProjectThreadSummaries,
  syncBoundedCatalog,
  syncSidebarCatalog,
  syncSelectedThreadDetail,
} from "./helpers.lazy.store";
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
  threadSummaryCursorByProjectId?: Record<string, ThreadSummaryCursor | null>;
  projectCatalogCursor?: GetStartupProjectCatalogResult["nextCursor"] | null;
  projectCatalogGeneration: number;
  projectCatalogLoading?: boolean;
  projectCatalogError?: string | undefined;
  latestProjectEventSequenceById?: Record<string, number>;
  deletedProjectSequenceById?: Record<string, number>;
  pendingUnloadedProjectPatchById?: Record<
    string,
    { sequence: number; patch: Partial<Omit<Project, "id">> }
  >;
  projectThreadCountsById?: Record<string, number>;
  sidebarRecentThreadIds: ThreadId[];
  sidebarPinnedThreadIds: ThreadId[];
  bootstrapComplete: boolean;
  threadHydrationById: Record<string, ThreadHydration>;
}

export type ThreadHydration =
  | { status: "unloaded" | "loading" | "loadingOlder" | "complete" }
  | { status: "loaded"; nextCursor: ThreadMessageCursor | null }
  | {
      status: "failed";
      error: string;
      retry: { kind: "initial" } | { kind: "older"; nextCursor: ThreadMessageCursor };
    };

const initialState: AppState = {
  projects: [],
  threads: [],
  sidebarThreadsById: {},
  threadIdsByProjectId: {},
  threadSummaryCursorByProjectId: {},
  projectCatalogCursor: null,
  projectCatalogGeneration: 0,
  projectCatalogLoading: false,
  projectCatalogError: undefined,
  latestProjectEventSequenceById: {},
  deletedProjectSequenceById: {},
  pendingUnloadedProjectPatchById: {},
  projectThreadCountsById: {},
  sidebarRecentThreadIds: [],
  sidebarPinnedThreadIds: [],
  bootstrapComplete: false,
  threadHydrationById: {},
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
  syncBoundedCatalog: (
    catalog: GetStartupProjectCatalogResult,
    sidebarCatalog: GetSidebarThreadCatalogResult,
    pages: ReadonlyArray<GetProjectThreadSummariesResult>,
  ) => void;
  syncSidebarCatalog: (sidebarCatalog: GetSidebarThreadCatalogResult) => void;
  syncSelectedThreadDetail: (detail: GetSelectedThreadDetailResult, loadingOlder: boolean) => void;
  appendProjectThreadSummaries: (page: GetProjectThreadSummariesResult) => void;
  appendProjectCatalogPage: (
    page: GetStartupProjectCatalogResult,
    generation?: number,
    loading?: boolean,
  ) => void;
  setProjectCatalogLoading: (loading: boolean, error?: string, generation?: number) => void;
  setThreadHydration: (threadId: ThreadId, hydration: ThreadHydration) => void;
  applyOrchestrationEvent: (event: OrchestrationEvent) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...initialState,
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  syncBoundedCatalog: (catalog, sidebarCatalog, pages) =>
    set((state) => syncBoundedCatalog(state, catalog, sidebarCatalog, pages)),
  syncSidebarCatalog: (sidebarCatalog) => set((state) => syncSidebarCatalog(state, sidebarCatalog)),
  syncSelectedThreadDetail: (detail, loadingOlder) =>
    set((state) => syncSelectedThreadDetail(state, detail, loadingOlder)),
  appendProjectThreadSummaries: (page) => set((state) => appendProjectThreadSummaries(state, page)),
  appendProjectCatalogPage: (page, generation, loading) =>
    set((state) => appendProjectCatalogPage(state, page, generation, loading)),
  setProjectCatalogLoading: (loading, error, generation) =>
    set((state) =>
      generation !== undefined && state.projectCatalogGeneration !== generation
        ? state
        : { ...state, projectCatalogLoading: loading, projectCatalogError: error },
    ),
  setThreadHydration: (threadId, hydration) =>
    set((state) => setThreadHydration(state, threadId, hydration)),
  applyOrchestrationEvent: (event) => set((state) => applyOrchestrationEvent(state, event)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
}));

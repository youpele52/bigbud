import {
  type GetProjectThreadSummariesResult,
  type GetSelectedThreadDetailResult,
  type GetStartupProjectCatalogResult,
  type ProjectCatalogScope,
  type ProjectId,
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
  mergeProjectCatalogPage,
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
  projectCatalogCursorByScope: Record<
    ProjectCatalogScope,
    GetStartupProjectCatalogResult["nextCursor"] | null
  >;
  projectCatalogRemainingCountByScope: Record<ProjectCatalogScope, number | null>;
  projectCatalogGenerationByScope: Record<ProjectCatalogScope, number>;
  projectCatalogLoadingByScope: Record<ProjectCatalogScope, boolean>;
  projectCatalogErrorByScope: Record<ProjectCatalogScope, string | undefined>;
  projectCatalogRetryHeadByScope: Record<ProjectCatalogScope, boolean>;
  projectCatalogRestartProjectIdByScope: Record<ProjectCatalogScope, ProjectId | null>;
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
  projectCatalogCursorByScope: { local: null, remote: null },
  projectCatalogRemainingCountByScope: { local: null, remote: null },
  projectCatalogGenerationByScope: { local: 0, remote: 0 },
  projectCatalogLoadingByScope: { local: false, remote: false },
  projectCatalogErrorByScope: { local: undefined, remote: undefined },
  projectCatalogRetryHeadByScope: { local: false, remote: false },
  projectCatalogRestartProjectIdByScope: { local: null, remote: null },
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
    catalogs: Partial<Record<ProjectCatalogScope, GetStartupProjectCatalogResult>>,
    catalogErrors: Partial<Record<ProjectCatalogScope, string>>,
    catalogRestartProjectIds: Partial<Record<ProjectCatalogScope, ProjectId>>,
    sidebarCatalog: GetSidebarThreadCatalogResult,
    pages: ReadonlyArray<GetProjectThreadSummariesResult>,
  ) => void;
  syncSidebarCatalog: (sidebarCatalog: GetSidebarThreadCatalogResult) => void;
  syncSelectedThreadDetail: (detail: GetSelectedThreadDetailResult, loadingOlder: boolean) => void;
  appendProjectThreadSummaries: (page: GetProjectThreadSummariesResult) => void;
  appendProjectCatalogPage: (
    scope: ProjectCatalogScope,
    page: GetStartupProjectCatalogResult,
    generation?: number,
    loading?: boolean,
  ) => void;
  mergeProjectCatalogPage: (page: GetStartupProjectCatalogResult) => void;
  setProjectCatalogLoading: (
    scope: ProjectCatalogScope,
    loading: boolean,
    error?: string,
    generation?: number,
  ) => void;
  setThreadHydration: (threadId: ThreadId, hydration: ThreadHydration) => void;
  applyOrchestrationEvent: (event: OrchestrationEvent) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...initialState,
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  syncBoundedCatalog: (catalogs, catalogErrors, catalogRestartProjectIds, sidebarCatalog, pages) =>
    set((state) =>
      syncBoundedCatalog(
        state,
        catalogs,
        catalogErrors,
        catalogRestartProjectIds,
        sidebarCatalog,
        pages,
      ),
    ),
  syncSidebarCatalog: (sidebarCatalog) => set((state) => syncSidebarCatalog(state, sidebarCatalog)),
  syncSelectedThreadDetail: (detail, loadingOlder) =>
    set((state) => syncSelectedThreadDetail(state, detail, loadingOlder)),
  appendProjectThreadSummaries: (page) => set((state) => appendProjectThreadSummaries(state, page)),
  appendProjectCatalogPage: (scope, page, generation, loading) =>
    set((state) => appendProjectCatalogPage(state, scope, page, generation, loading)),
  mergeProjectCatalogPage: (page) => set((state) => mergeProjectCatalogPage(state, page)),
  setProjectCatalogLoading: (scope, loading, error, generation) =>
    set((state) =>
      generation !== undefined && state.projectCatalogGenerationByScope[scope] !== generation
        ? state
        : {
            ...state,
            projectCatalogLoadingByScope: {
              ...state.projectCatalogLoadingByScope,
              [scope]: loading,
            },
            projectCatalogErrorByScope: { ...state.projectCatalogErrorByScope, [scope]: error },
          },
    ),
  setThreadHydration: (threadId, hydration) =>
    set((state) => setThreadHydration(state, threadId, hydration)),
  applyOrchestrationEvent: (event) => set((state) => applyOrchestrationEvent(state, event)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
}));

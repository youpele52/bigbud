import type { AppState } from "./main.store";

/** Sequences are comparable only within one authoritative server/database epoch. */
export function resetProjectCatalogState(
  state: AppState,
  serverEpoch = state.projectServerEpoch,
): AppState {
  return {
    ...state,
    projects: [],
    projectServerEpoch: serverEpoch,
    projectDependencyOnlyIds: {},
    projectCatalogSequenceById: {},
    latestProjectEventSequenceById: {},
    deletedProjectSequenceById: {},
    pendingUnloadedProjectPatchById: {},
    projectThreadCountsById: {},
    projectCatalogCursorByScope: { local: null, remote: null },
    projectCatalogRemainingCountByScope: { local: null, remote: null },
    projectCatalogGenerationByScope: {
      local: state.projectCatalogGenerationByScope.local + 1,
      remote: state.projectCatalogGenerationByScope.remote + 1,
    },
    projectCatalogLoadingByScope: { local: false, remote: false },
    projectCatalogErrorByScope: { local: undefined, remote: undefined },
    projectCatalogRetryHeadByScope: { local: false, remote: false },
    projectCatalogRestartProjectIdByScope: { local: null, remote: null },
  };
}

import type { GetStartupProjectCatalogResult, ProjectCatalogScope } from "@bigbud/contracts";
import type { Project } from "../../models/types";
import type { AppState } from "./main.store";

/** Lookup-only metadata never joins sidebar catalog membership. */
export function selectCatalogProjects(state: AppState): Project[] {
  return state.projects.filter((project) => !state.projectDependencyOnlyIds?.[project.id]);
}

export function promoteProjectToCatalog(state: AppState, id: string) {
  const ids = { ...state.projectDependencyOnlyIds };
  delete ids[id];
  return ids;
}

export function projectDependencyMembership(
  state: AppState,
  projects: Project[],
  page: GetStartupProjectCatalogResult,
  lookup: boolean,
  scope?: ProjectCatalogScope,
): Record<string, true> {
  const ids: Record<string, true> = {};
  const existingIds = new Set(state.projects.map((project) => project.id));
  const pageIds = new Set(page.projects.map((project) => project.id));
  for (const project of projects) {
    const wasDependency = state.projectDependencyOnlyIds?.[project.id];
    const inScope =
      scope !== undefined &&
      (project.workspaceExecutionTargetId === "local") === (scope === "local");
    const retainedOnlyForDependency =
      inScope &&
      !pageIds.has(project.id) &&
      Math.max(
        state.latestProjectEventSequenceById?.[project.id] ?? 0,
        state.projectCatalogSequenceById?.[project.id] ?? 0,
      ) <= page.projectionSequence;
    if (
      lookup
        ? wasDependency || !existingIds.has(project.id)
        : !pageIds.has(project.id) && (wasDependency || retainedOnlyForDependency)
    ) {
      ids[project.id] = true;
    }
  }
  return ids;
}

/** Unmounted lookups (e.g. new-thread preflight) get a small bounded cache. */
export const PROJECT_DEPENDENCY_CACHE_LIMIT = 8;

export function pruneProjectDependencies(state: AppState, releaseId?: string): AppState {
  const dependencyIds = { ...state.projectDependencyOnlyIds };
  const unused = state.projects.filter(
    (project) => dependencyIds[project.id] && !state.projectDependencyRefCounts?.[project.id],
  );
  const evicted = new Set(
    unused
      .filter(
        (project, index) =>
          project.id === releaseId || index < unused.length - PROJECT_DEPENDENCY_CACHE_LIMIT,
      )
      .map((project) => project.id),
  );
  const projects = state.projects.filter((project) => !evicted.has(project.id));
  const sequences = { ...state.projectCatalogSequenceById };
  const retainedIds = new Set(projects.map((project) => project.id));
  for (const id of Object.keys(dependencyIds)) {
    if (!retainedIds.has(id as Project["id"])) delete dependencyIds[id];
  }
  for (const id of evicted) delete sequences[id];
  return {
    ...state,
    projects,
    projectDependencyOnlyIds: dependencyIds,
    projectCatalogSequenceById: sequences,
  };
}

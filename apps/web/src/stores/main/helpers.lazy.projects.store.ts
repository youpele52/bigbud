import type { GetStartupProjectCatalogResult, ProjectCatalogScope } from "@bigbud/contracts";

import type { AppState } from "./main.store";
import { mapProjectSummary } from "./mappers.lazy.store";
import { projectDependencyMembership } from "./helpers.projectDependencies.store";

function applyActiveThreadCount(
  project: AppState["projects"][number],
  projectThreadCountsById: AppState["projectThreadCountsById"],
) {
  const activeThreadCount = projectThreadCountsById?.[project.id];
  return activeThreadCount === undefined ? project : { ...project, activeThreadCount };
}

export function mergeProjectCatalog(
  state: AppState,
  page: GetStartupProjectCatalogResult,
  projectThreadCountsById: AppState["projectThreadCountsById"],
  preserveUnlistedProjects: boolean,
  scope?: ProjectCatalogScope,
  lookup = false,
) {
  const latestEventSequences = state.latestProjectEventSequenceById ?? {};
  const deletionSequences = state.deletedProjectSequenceById ?? {};
  const catalogSequences = { ...state.projectCatalogSequenceById };
  const pendingPatches = { ...state.pendingUnloadedProjectPatchById };
  const existingProjects = new Map(state.projects.map((project) => [project.id, project]));
  const projectsById = new Map(
    preserveUnlistedProjects
      ? existingProjects
      : state.projects
          .filter(
            (project) =>
              (state.projectDependencyRefCounts?.[project.id] ?? 0) > 0 ||
              (scope !== undefined &&
                (project.workspaceExecutionTargetId === "local") !== (scope === "local")) ||
              (Math.max(latestEventSequences[project.id] ?? 0, catalogSequences[project.id] ?? 0) >
                page.projectionSequence &&
                (deletionSequences[project.id] ?? 0) <= page.projectionSequence),
          )
          .map((project) => [project.id, project]),
  );

  for (const project of page.projects) {
    const latestEventSequence = latestEventSequences[project.id] ?? 0;
    const latestDeletionSequence = deletionSequences[project.id] ?? 0;
    if (latestDeletionSequence > page.projectionSequence) {
      continue;
    }

    const existingProject = existingProjects.get(project.id);
    const pendingPatch = pendingPatches[project.id];
    const baseProject =
      existingProject &&
      Math.max(latestEventSequence, catalogSequences[project.id] ?? 0) > page.projectionSequence
        ? existingProject
        : mapProjectSummary(project);
    const mergedProject = {
      ...baseProject,
      ...(pendingPatch && pendingPatch.sequence > page.projectionSequence
        ? pendingPatch.patch
        : {}),
    };
    catalogSequences[project.id] = Math.max(
      catalogSequences[project.id] ?? 0,
      page.projectionSequence,
    );
    projectsById.set(project.id, applyActiveThreadCount(mergedProject, projectThreadCountsById));
    delete pendingPatches[project.id];
  }

  const projects = [...projectsById.values()];
  return {
    projects,
    projectDependencyOnlyIds: projectDependencyMembership(state, projects, page, lookup, scope),
    pendingUnloadedProjectPatchById: pendingPatches,
    projectCatalogSequenceById: Object.fromEntries(
      [...projectsById.keys()].map((id) => [id, catalogSequences[id] ?? 0]),
    ),
  };
}

import type { GetStartupProjectCatalogResult } from "@bigbud/contracts";

import type { AppState } from "./main.store";
import { mapProjectSummary } from "./mappers.lazy.store";

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
) {
  const latestEventSequences = state.latestProjectEventSequenceById ?? {};
  const deletionSequences = state.deletedProjectSequenceById ?? {};
  const pendingPatches = { ...state.pendingUnloadedProjectPatchById };
  const existingProjects = new Map(state.projects.map((project) => [project.id, project]));
  const projectsById = new Map(
    preserveUnlistedProjects
      ? existingProjects
      : state.projects
          .filter(
            (project) =>
              (latestEventSequences[project.id] ?? 0) > page.projectionSequence &&
              (deletionSequences[project.id] ?? 0) <= page.projectionSequence,
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
      existingProject && latestEventSequence > page.projectionSequence
        ? existingProject
        : mapProjectSummary(project);
    const mergedProject = {
      ...baseProject,
      ...(pendingPatch && pendingPatch.sequence > page.projectionSequence
        ? pendingPatch.patch
        : {}),
    };
    projectsById.set(project.id, applyActiveThreadCount(mergedProject, projectThreadCountsById));
    delete pendingPatches[project.id];
  }

  return {
    projects: [...projectsById.values()],
    pendingUnloadedProjectPatchById: pendingPatches,
  };
}

import type { GetStartupProjectCatalogResult, NativeApi, ProjectId } from "@bigbud/contracts";

import type { Project } from "../models/types";

const pendingProjectLoads = new Map<ProjectId, Promise<Project | undefined>>();

export async function loadProjectForNewThread(input: {
  api: Pick<NativeApi, "orchestration">;
  projectId: ProjectId;
  getProject: () => Project | undefined;
  mergeProjectCatalogPage: (page: GetStartupProjectCatalogResult) => void;
}): Promise<Project | undefined> {
  const existingProject = input.getProject();
  if (existingProject) return existingProject;

  const pendingLoad = pendingProjectLoads.get(input.projectId);
  if (pendingLoad) return pendingLoad;

  const load = Promise.allSettled(
    (["local", "remote"] as const).map((scope) =>
      input.api.orchestration.getStartupProjectCatalog({
        scope,
        limit: 1,
        priorityProjectId: input.projectId,
      }),
    ),
  )
    .then((results) => {
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const page = result.value;
        if (page.projects.some((candidate) => candidate.id === input.projectId)) {
          input.mergeProjectCatalogPage(page);
        }
      }
      const loadedProject = input.getProject();
      if (loadedProject) return loadedProject;
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length === results.length) throw failures[0]!.reason;
      return undefined;
    })
    .finally(() => pendingProjectLoads.delete(input.projectId));
  pendingProjectLoads.set(input.projectId, load);
  return load;
}

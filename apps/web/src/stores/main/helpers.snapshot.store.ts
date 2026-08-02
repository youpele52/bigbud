import type { OrchestrationReadModel } from "@bigbud/contracts";
import { isBuiltInChatsProject } from "@bigbud/contracts/constants/project.constant";

import { buildSidebarThreadsById, buildThreadIdsByProjectId } from "./helpers.store";
import { deriveProjectActiveThreadCounts } from "./helpers.projectThreadCount.store";
import type { AppState } from "./main.store";
import { mapProject, mapThread } from "./mappers.store";

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  const mappedProjects = readModel.projects
    .filter((project) => project.deletedAt === null)
    .map(mapProject);
  const threads = readModel.threads.filter((thread) => thread.deletedAt === null).map(mapThread);
  const visibleThreads = threads.filter((thread) => thread.purpose !== "side-chat");
  const projects = deriveProjectActiveThreadCounts(mappedProjects, threads);
  return {
    ...state,
    projects,
    threads,
    sidebarThreadsById: buildSidebarThreadsById(visibleThreads),
    threadIdsByProjectId: buildThreadIdsByProjectId(visibleThreads),
    sidebarRecentThreadIds: visibleThreads
      .filter((thread) => isBuiltInChatsProject(thread.projectId))
      .map((thread) => thread.id),
    sidebarPinnedThreadIds: visibleThreads
      .filter((thread) => thread.pinnedAt !== null)
      .toSorted(
        (left, right) =>
          (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? "") ||
          left.id.localeCompare(right.id),
      )
      .map((thread) => thread.id),
    bootstrapComplete: true,
  };
}

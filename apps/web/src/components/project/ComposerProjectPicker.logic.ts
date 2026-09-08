import { isBuiltInChatsProject, type ProjectId } from "@bigbud/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@bigbud/contracts/settings";

import type { Project, SidebarThreadSummary } from "../../models/types";
import { orderItemsByPreferredIds } from "../sidebar/Sidebar.logic";
import { sortProjectsForSidebar, sortThreadsForSidebar } from "../sidebar/Sidebar.sort.logic";
import { collectVisibleChatThreads } from "../sidebar/Sidebar.state.visibleThreads";

export const COMPOSER_PICKER_RECENT_LIMIT = 4;

export function getComposerPickerChatRecents(input: {
  loadedChatThreadIds: readonly string[];
  sidebarRecentThreadIds: readonly string[];
  sidebarThreadsById: Record<string, SidebarThreadSummary>;
  sortOrder: SidebarThreadSortOrder;
}): SidebarThreadSummary[] {
  return sortThreadsForSidebar(collectVisibleChatThreads(input), input.sortOrder).slice(
    0,
    COMPOSER_PICKER_RECENT_LIMIT,
  );
}

export function getComposerPickerProjectThreads(input: {
  projectId: ProjectId;
  sidebarThreadsById: Record<string, SidebarThreadSummary>;
  threadIdsByProjectId: Partial<Record<ProjectId, readonly string[]>>;
  sortOrder: SidebarThreadSortOrder;
}): SidebarThreadSummary[] {
  return sortThreadsForSidebar(
    (input.threadIdsByProjectId[input.projectId] ?? [])
      .map((threadId) => input.sidebarThreadsById[threadId])
      .filter((thread): thread is SidebarThreadSummary => thread !== undefined)
      .filter((thread) => thread.archivedAt === null && thread.deletingAt === null),
    input.sortOrder,
  );
}

export function getComposerPickerProjects(input: {
  projectOrder: readonly ProjectId[];
  projects: readonly Project[];
  sidebarThreadsById: Record<string, SidebarThreadSummary>;
  sortOrder: SidebarProjectSortOrder;
}): Project[] {
  const visibleProjects = input.projects.filter((project) => project.deletingAt == null);
  const orderedProjects = orderItemsByPreferredIds({
    items: visibleProjects,
    preferredIds: input.projectOrder,
    getId: (project) => project.id,
  });
  const visibleThreads = Object.values(input.sidebarThreadsById).filter(
    (thread) => thread.archivedAt === null && thread.deletingAt === null,
  );
  const sortedProjects = sortProjectsForSidebar(orderedProjects, visibleThreads, input.sortOrder);
  const chatsProject = sortedProjects.find((project) => isBuiltInChatsProject(project.id));

  return chatsProject
    ? [chatsProject, ...sortedProjects.filter((project) => project.id !== chatsProject.id)]
    : sortedProjects;
}

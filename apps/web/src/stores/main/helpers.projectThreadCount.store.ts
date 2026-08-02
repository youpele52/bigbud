import type { ProjectThreadCount } from "@bigbud/contracts/orchestration/orchestration.catalog";

import {
  indexActiveSidebarThreadIdsByProject,
  isActiveSidebarProjectThread,
} from "../../logic/thread/sidebarThreadCount.logic";
import type { Project, Thread } from "../../models/types";

export function deriveProjectActiveThreadCounts(
  projects: readonly Project[],
  threads: readonly Thread[],
): Project[] {
  const activeThreadIdsByProject = indexActiveSidebarThreadIdsByProject(threads);
  return projects.map((project) => ({
    ...project,
    activeThreadCount: activeThreadIdsByProject.get(project.id)?.size ?? 0,
  }));
}

export function applyAuthoritativeProjectThreadCounts(
  projects: Project[],
  counts: readonly ProjectThreadCount[] | undefined,
): Project[] {
  if (counts === undefined) return projects;
  const countByProjectId = new Map(counts.map((entry) => [entry.projectId, entry.threadCount]));
  let changed = false;
  const nextProjects = projects.map((project) => {
    const activeThreadCount = countByProjectId.get(project.id);
    if (activeThreadCount === undefined || activeThreadCount === project.activeThreadCount) {
      return project;
    }
    changed = true;
    return { ...project, activeThreadCount };
  });
  return changed ? nextProjects : projects;
}

export function applyActiveThreadCountTransition(
  projects: Project[],
  previous: Thread | undefined,
  next: Thread | undefined,
): Project[] {
  const deltas = new Map<string, number>();
  if (previous && isActiveSidebarProjectThread(previous)) {
    deltas.set(previous.projectId, (deltas.get(previous.projectId) ?? 0) - 1);
  }
  if (next && isActiveSidebarProjectThread(next)) {
    deltas.set(next.projectId, (deltas.get(next.projectId) ?? 0) + 1);
  }
  if ([...deltas.values()].every((delta) => delta === 0)) return projects;
  return projects.map((project) => {
    const delta = deltas.get(project.id) ?? 0;
    if (delta === 0 || project.activeThreadCount === undefined) return project;
    return { ...project, activeThreadCount: Math.max(0, project.activeThreadCount + delta) };
  });
}

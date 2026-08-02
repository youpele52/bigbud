import type { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { OrchestrationThreadPurpose } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

export interface SidebarThreadCountMember {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly purpose?: OrchestrationThreadPurpose;
  readonly archivedAt: string | null;
  readonly deletingAt?: string | null;
}

export function isActiveSidebarProjectThread(thread: SidebarThreadCountMember): boolean {
  return thread.purpose !== "side-chat" && thread.archivedAt === null && thread.deletingAt == null;
}

export function indexActiveSidebarThreadIdsByProject(
  threads: readonly SidebarThreadCountMember[],
): ReadonlyMap<ProjectId, ReadonlySet<ThreadId>> {
  const idsByProject = new Map<ProjectId, Set<ThreadId>>();
  for (const thread of threads) {
    if (!isActiveSidebarProjectThread(thread)) continue;
    const projectThreadIds = idsByProject.get(thread.projectId) ?? new Set<ThreadId>();
    projectThreadIds.add(thread.id);
    idsByProject.set(thread.projectId, projectThreadIds);
  }
  return idsByProject;
}

export function getRemainingSidebarThreadCount<T>(input: {
  readonly authoritativeActiveThreadCount: number | undefined;
  readonly representedThreadIds: Iterable<T>;
}): number | null {
  if (input.authoritativeActiveThreadCount === undefined) return null;
  return Math.max(
    0,
    input.authoritativeActiveThreadCount - new Set(input.representedThreadIds).size,
  );
}

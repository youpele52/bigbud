import { isBuiltInChatsProject } from "@bigbud/contracts/constants/project.constant";
import { useMemo } from "react";

import type { SidebarThreadSummary } from "../../models/types";

export function useSidebarVisibleThreads(input: {
  sidebarThreads: readonly SidebarThreadSummary[];
  sidebarThreadsById: Record<string, SidebarThreadSummary>;
  sidebarRecentThreadIds: readonly string[];
  loadedChatThreadIds: readonly string[];
}) {
  const visibleThreads = useMemo(
    () =>
      input.sidebarThreads.filter(
        (thread) => thread.archivedAt === null && thread.deletingAt === null,
      ),
    [input.sidebarThreads],
  );
  const visibleChatThreads = useMemo(
    () =>
      [...new Set([...input.sidebarRecentThreadIds, ...input.loadedChatThreadIds])]
        .map((threadId) => input.sidebarThreadsById[threadId])
        .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
        .filter((thread) => thread.archivedAt === null && thread.deletingAt === null)
        .filter((thread) => isBuiltInChatsProject(thread.projectId)),
    [input.loadedChatThreadIds, input.sidebarRecentThreadIds, input.sidebarThreadsById],
  );

  return { visibleThreads, visibleChatThreads };
}

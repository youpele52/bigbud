import {
  FAVORITE_THREAD_LIMIT,
  type SidebarThreadSortOrder,
  type ThreadId,
} from "@bigbud/contracts";
import { useMemo } from "react";
import { getVisibleRecentThreadIds, sortThreadsForSidebar } from "./Sidebar.logic";
import { RECENT_CHAT_INITIAL_VISIBLE_COUNT } from "./Sidebar.chatsSection";
import type { SidebarRenderedThreadEntry } from "./Sidebar.types";
import type { SidebarThreadSummary } from "../../models/types";

interface UseSidebarRecentSectionsInput {
  favoriteThreadIds: readonly ThreadId[];
  sidebarThreadsById: Record<string, SidebarThreadSummary>;
  visibleChatThreads: readonly SidebarThreadSummary[];
  sidebarChatsSortOrder: SidebarThreadSortOrder;
  areChatsExpanded: boolean;
  showAllChats: boolean;
}

export function useSidebarRecentSections(input: UseSidebarRecentSectionsInput) {
  const favoriteThreadIds = useMemo(
    () => new Set<ThreadId>(input.favoriteThreadIds),
    [input.favoriteThreadIds],
  );

  const renderedFavorites = useMemo<SidebarRenderedThreadEntry[]>(() => {
    const orderedThreadIds = input.favoriteThreadIds
      .map((threadId) => input.sidebarThreadsById[threadId])
      .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
      .filter((thread) => thread.archivedAt === null && thread.deletingAt === null)
      .map((thread) => thread.id)
      .slice(0, FAVORITE_THREAD_LIMIT);

    return orderedThreadIds.map((threadId) => ({
      threadId,
      orderedThreadIds,
    }));
  }, [input.favoriteThreadIds, input.sidebarThreadsById]);

  const renderedChats = useMemo<SidebarRenderedThreadEntry[]>(() => {
    const orderedChats = sortThreadsForSidebar(
      input.visibleChatThreads,
      input.sidebarChatsSortOrder,
    );
    const orderedThreadIds = orderedChats.map((entry) => entry.id);
    return orderedChats.map((thread) => ({
      threadId: thread.id,
      orderedThreadIds,
    }));
  }, [input.sidebarChatsSortOrder, input.visibleChatThreads]);

  const visibleChatThreadIdsForJumpHints = useMemo(
    () =>
      getVisibleRecentThreadIds({
        renderedChatThreadIds: renderedChats.map((entry) => entry.threadId),
        isExpanded: input.areChatsExpanded,
        showAll: input.showAllChats,
        initialVisibleCount: RECENT_CHAT_INITIAL_VISIBLE_COUNT,
      }),
    [input.areChatsExpanded, renderedChats, input.showAllChats],
  );

  return {
    favoriteThreadIds,
    renderedFavorites,
    renderedChats,
    visibleChatThreadIdsForJumpHints,
  };
}

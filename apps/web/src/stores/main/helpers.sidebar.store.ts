import { type ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { FAVORITE_THREAD_LIMIT } from "@bigbud/contracts/constants/settings.constant";
import { SIDEBAR_THREAD_CATALOG_MAX_RECENT_MEMBERS } from "@bigbud/contracts/orchestration/orchestration.catalog";

export function prependBoundedSidebarThreadId(
  threadIds: readonly ThreadId[],
  threadId: ThreadId,
  limit: number,
): ThreadId[] {
  return [threadId, ...threadIds.filter((id) => id !== threadId)].slice(0, limit);
}

export function prependSidebarRecentThreadId(
  threadIds: readonly ThreadId[],
  threadId: ThreadId,
): ThreadId[] {
  return prependBoundedSidebarThreadId(
    threadIds,
    threadId,
    SIDEBAR_THREAD_CATALOG_MAX_RECENT_MEMBERS,
  );
}

export function prependSidebarPinnedThreadId(
  threadIds: readonly ThreadId[],
  threadId: ThreadId,
): ThreadId[] {
  return prependBoundedSidebarThreadId(threadIds, threadId, FAVORITE_THREAD_LIMIT);
}

export function removeSidebarThreadId(
  threadIds: readonly ThreadId[],
  threadId: ThreadId,
): ThreadId[] {
  return threadIds.filter((id) => id !== threadId);
}

export function normalizeSidebarThreadIds(
  threadIds: readonly ThreadId[],
  availableThreadIds: ReadonlySet<ThreadId>,
  limit: number,
): ThreadId[] {
  return [...new Set(threadIds)].filter((id) => availableThreadIds.has(id)).slice(0, limit);
}

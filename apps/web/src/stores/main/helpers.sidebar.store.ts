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

export function mergeDeletingSidebarMembership(input: {
  readonly catalogThreadIds: readonly ThreadId[];
  readonly localThreadIds: readonly ThreadId[];
  readonly localThreads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly deletingAt?: string | null;
  }>;
  readonly catalogAvailableIds: ReadonlySet<ThreadId>;
  readonly limit: number;
}): ThreadId[] {
  const deletingIds = new Set(
    input.localThreads.filter((thread) => thread.deletingAt != null).map((thread) => thread.id),
  );
  const retained = input.localThreadIds.filter((threadId) => deletingIds.has(threadId));
  return normalizeSidebarThreadIds(
    [...retained, ...input.catalogThreadIds],
    new Set([...input.catalogAvailableIds, ...retained]),
    input.limit,
  );
}

export function sidebarMembershipFromCatalog(input: {
  readonly recentThreadIds: readonly ThreadId[];
  readonly pinnedThreadIds: readonly ThreadId[];
  readonly localRecentThreadIds: readonly ThreadId[];
  readonly localPinnedThreadIds: readonly ThreadId[];
  readonly localThreads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly deletingAt?: string | null;
  }>;
  readonly catalogAvailableIds: ReadonlySet<ThreadId>;
}): {
  readonly sidebarRecentThreadIds: ThreadId[];
  readonly sidebarPinnedThreadIds: ThreadId[];
} {
  return {
    sidebarRecentThreadIds: mergeDeletingSidebarMembership({
      catalogThreadIds: input.recentThreadIds,
      localThreadIds: input.localRecentThreadIds,
      localThreads: input.localThreads,
      catalogAvailableIds: input.catalogAvailableIds,
      limit: SIDEBAR_THREAD_CATALOG_MAX_RECENT_MEMBERS,
    }),
    sidebarPinnedThreadIds: mergeDeletingSidebarMembership({
      catalogThreadIds: input.pinnedThreadIds,
      localThreadIds: input.localPinnedThreadIds,
      localThreads: input.localThreads,
      catalogAvailableIds: input.catalogAvailableIds,
      limit: FAVORITE_THREAD_LIMIT,
    }),
  };
}

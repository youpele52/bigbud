import type { GetSidebarThreadCatalogResult } from "@bigbud/contracts/orchestration/orchestration.catalog";
import type { Thread } from "~/models/types";

type ThreadPurpose = Pick<Thread, "purpose">;

export function isSidecarThread(thread: ThreadPurpose): boolean {
  return thread.purpose === "side-chat";
}

export function isVisibleThread(thread: ThreadPurpose): boolean {
  return !isSidecarThread(thread);
}

/** Sidecars are never sidebar threads, even when a server catalog lists them. */
export function withoutSidecarCatalogThreads(
  catalog: GetSidebarThreadCatalogResult,
): GetSidebarThreadCatalogResult {
  const sidecarIds = new Set(catalog.threads.filter(isSidecarThread).map((thread) => thread.id));
  if (sidecarIds.size === 0) return catalog;
  const isListed = (threadId: string) => !sidecarIds.has(threadId as Thread["id"]);
  return {
    ...catalog,
    threads: catalog.threads.filter((thread) => isListed(thread.id)),
    recentThreadIds: catalog.recentThreadIds.filter(isListed),
    pinnedThreadIds: catalog.pinnedThreadIds.filter(isListed),
  };
}

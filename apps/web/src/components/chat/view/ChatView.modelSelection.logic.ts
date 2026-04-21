import { type ModelSelection, type ProviderKind, type ThreadId } from "@bigbud/contracts";
import { useMemo } from "react";
import { LRUCache } from "../../../lib/lruCache";
import { useStore } from "../../../stores/main";
import type { Thread } from "../../../models/types";

export function providerSupportsSubProviderID(provider: ProviderKind): boolean {
  return provider === "opencode" || provider === "pi";
}

export function getModelSelectionSubProviderID(
  selection: ModelSelection | null | undefined,
): string | null {
  return (selection?.provider === "opencode" || selection?.provider === "pi") &&
    typeof selection.subProviderID === "string"
    ? selection.subProviderID
    : null;
}

export function modelSelectionsEqual(
  left: ModelSelection | null | undefined,
  right: ModelSelection | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return left === right;
  }
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null) &&
    getModelSelectionSubProviderID(left) === getModelSelectionSubProviderID(right)
  );
}

export function modelPickerValue(selection: ModelSelection | null | undefined): string {
  const model = selection?.model?.trim();
  if (!model) {
    return "";
  }
  const subProviderID = getModelSelectionSubProviderID(selection);
  return subProviderID ? `${model}::${subProviderID}` : model;
}

export type ThreadPlanCatalogEntry = Pick<Thread, "id" | "proposedPlans">;

const MAX_THREAD_PLAN_CATALOG_CACHE_ENTRIES = 500;
const MAX_THREAD_PLAN_CATALOG_CACHE_MEMORY_BYTES = 512 * 1024;
const threadPlanCatalogCache = new LRUCache<{
  proposedPlans: Thread["proposedPlans"];
  entry: ThreadPlanCatalogEntry;
}>(MAX_THREAD_PLAN_CATALOG_CACHE_ENTRIES, MAX_THREAD_PLAN_CATALOG_CACHE_MEMORY_BYTES);

function estimateThreadPlanCatalogEntrySize(thread: Thread): number {
  return Math.max(
    64,
    thread.id.length +
      thread.proposedPlans.reduce(
        (total, plan) =>
          total +
          plan.id.length +
          plan.planMarkdown.length +
          plan.updatedAt.length +
          (plan.turnId?.length ?? 0),
        0,
      ),
  );
}

function toThreadPlanCatalogEntry(thread: Thread): ThreadPlanCatalogEntry {
  const cached = threadPlanCatalogCache.get(thread.id);
  if (cached && cached.proposedPlans === thread.proposedPlans) {
    return cached.entry;
  }

  const entry: ThreadPlanCatalogEntry = {
    id: thread.id,
    proposedPlans: thread.proposedPlans,
  };
  threadPlanCatalogCache.set(
    thread.id,
    {
      proposedPlans: thread.proposedPlans,
      entry,
    },
    estimateThreadPlanCatalogEntrySize(thread),
  );
  return entry;
}

export function useThreadPlanCatalog(threadIds: readonly ThreadId[]): ThreadPlanCatalogEntry[] {
  const selector = useMemo(() => {
    let previousThreads: Array<Thread | undefined> | null = null;
    let previousEntries: ThreadPlanCatalogEntry[] = [];

    return (state: { threads: Thread[] }): ThreadPlanCatalogEntry[] => {
      const nextThreads = threadIds.map((threadId) =>
        state.threads.find((thread) => thread.id === threadId),
      );
      const cachedThreads = previousThreads;
      if (
        cachedThreads &&
        nextThreads.length === cachedThreads.length &&
        nextThreads.every((thread, index) => thread === cachedThreads[index])
      ) {
        return previousEntries;
      }

      previousThreads = nextThreads;
      previousEntries = nextThreads.flatMap((thread) =>
        thread ? [toThreadPlanCatalogEntry(thread)] : [],
      );
      return previousEntries;
    };
  }, [threadIds]);

  return useStore(selector);
}

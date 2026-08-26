import type { OrchestrationThread } from "@bigbud/contracts";
import type { ProviderSessionRuntimeListCursor } from "../../persistence/Services/ProviderSessionRuntime.ts";

export const PERIODIC_RECONCILIATION_BATCH_SIZE = 100;
export const PERIODIC_RECONCILIATION_RECENT_WINDOW_MS = 15 * 60 * 1000;
const MAX_DIRTY_RECONCILIATION_THREADS = 10_000;

export interface PeriodicReconciliationState {
  cursorThreadId: string | null;
  readonly dirtyThreadIds: Set<string>;
  readonly missingSessionObservedAt: Map<string, number>;
  auditCursor: ProviderSessionRuntimeListCursor | null;
  lastSafetyAuditAt: number;
}

export function makePeriodicReconciliationState(): PeriodicReconciliationState {
  return {
    cursorThreadId: null,
    dirtyThreadIds: new Set(),
    missingSessionObservedAt: new Map(),
    auditCursor: null,
    lastSafetyAuditAt: 0,
  };
}

export function markPeriodicReconciliationDirty(
  state: PeriodicReconciliationState,
  threadId: string,
): void {
  state.dirtyThreadIds.add(threadId);
  while (state.dirtyThreadIds.size > MAX_DIRTY_RECONCILIATION_THREADS) {
    const oldest = state.dirtyThreadIds.values().next().value;
    if (oldest === undefined) break;
    state.dirtyThreadIds.delete(oldest);
  }
}

export function selectPeriodicReconciliationThreads(
  threads: ReadonlyArray<OrchestrationThread>,
  state: PeriodicReconciliationState,
  observedAt = Date.now(),
): ReadonlyArray<OrchestrationThread> {
  const eligible = threads
    .filter((thread) => {
      if (thread.deletedAt !== null || thread.archivedAt !== null) return false;
      if (
        thread.pendingInterruptFlushIntent != null ||
        thread.pendingTurnControlOperation != null ||
        (thread.session?.activeTurnId ?? null) !== null
      ) {
        return true;
      }
      if (thread.session?.status !== "running") return false;
      if (state.dirtyThreadIds.has(thread.id)) return true;
      const updatedAt = Date.parse(thread.session.updatedAt);
      return (
        Number.isFinite(updatedAt) &&
        updatedAt >= observedAt - PERIODIC_RECONCILIATION_RECENT_WINDOW_MS
      );
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
  if (eligible.length === 0) {
    state.cursorThreadId = null;
    return [];
  }
  const dirty = eligible.filter((thread) => state.dirtyThreadIds.has(thread.id));
  const remaining = eligible.filter((thread) => !state.dirtyThreadIds.has(thread.id));
  const ordered = [...dirty, ...remaining];
  const cursorThreadId = state.cursorThreadId;
  const firstAfterCursor =
    cursorThreadId === null ? 0 : ordered.findIndex((thread) => thread.id > cursorThreadId);
  const start = firstAfterCursor === -1 ? 0 : firstAfterCursor;
  const selected = Array.from(
    { length: Math.min(PERIODIC_RECONCILIATION_BATCH_SIZE, ordered.length) },
    (_, index) => ordered[(start + index) % ordered.length]!,
  );
  state.cursorThreadId = selected.at(-1)?.id ?? null;
  for (const thread of selected) state.dirtyThreadIds.delete(thread.id);
  return selected;
}

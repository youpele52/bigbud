import type { OrchestrationThread } from "@bigbud/contracts";

export const PERIODIC_RECONCILIATION_BATCH_SIZE = 100;

export interface PeriodicReconciliationState {
  cursorThreadId: string | null;
  readonly missingSessionObservedAt: Map<string, number>;
}

export function makePeriodicReconciliationState(): PeriodicReconciliationState {
  return { cursorThreadId: null, missingSessionObservedAt: new Map() };
}

export function selectPeriodicReconciliationThreads(
  threads: ReadonlyArray<OrchestrationThread>,
  state: PeriodicReconciliationState,
): ReadonlyArray<OrchestrationThread> {
  const eligible = threads
    .filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        (thread.pendingInterruptFlushIntent != null ||
          thread.pendingTurnControlOperation != null ||
          (thread.session?.activeTurnId ?? null) !== null ||
          thread.session?.status === "running"),
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
  if (eligible.length === 0) {
    state.cursorThreadId = null;
    return [];
  }
  const cursorThreadId = state.cursorThreadId;
  const firstAfterCursor =
    cursorThreadId === null ? 0 : eligible.findIndex((thread) => thread.id > cursorThreadId);
  const start = firstAfterCursor === -1 ? 0 : firstAfterCursor;
  const selected = Array.from(
    { length: Math.min(PERIODIC_RECONCILIATION_BATCH_SIZE, eligible.length) },
    (_, index) => eligible[(start + index) % eligible.length]!,
  );
  state.cursorThreadId = selected.at(-1)?.id ?? null;
  return selected;
}

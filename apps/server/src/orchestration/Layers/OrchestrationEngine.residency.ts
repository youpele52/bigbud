import type { OrchestrationThread, ThreadId } from "@bigbud/contracts";
import { ServiceMap } from "effect";

/**
 * Read-model residency bounds (F-B4). The engine read model starts with the operational window
 * and hydrates any other thread on demand; these bounds evict hydrated threads again once idle.
 *
 * - A resident thread untouched for `READ_MODEL_THREAD_IDLE_TTL_MS` is a candidate.
 * - Above `READ_MODEL_MAX_RESIDENT_THREADS`, the least recently used threads untouched for at
 *   least `READ_MODEL_MIN_RESIDENCY_MS` are candidates too, until the count is back at the bound.
 * - One sweep checks at most `READ_MODEL_EVICTION_BATCH` candidates, so the command barrier is
 *   held for a bounded number of per-thread SQL checks.
 *
 * A candidate is evicted only when nothing keeps it (`isThreadResidentWorkIdle`, no resident
 * child, no deletion fence, no live provider session or terminal, and the per-thread SQL check
 * shows it is not operational). Overflow is never a drop: an evicted thread is rehydrated from
 * durable projections on its next access, and a thread that cannot be evicted simply stays.
 */
export const READ_MODEL_MAX_RESIDENT_THREADS = 500;
export const READ_MODEL_THREAD_IDLE_TTL_MS = 10 * 60_000;
export const READ_MODEL_MIN_RESIDENCY_MS = 60_000;
export const READ_MODEL_EVICTION_BATCH = 200;
export const READ_MODEL_EVICTION_SWEEP_INTERVAL_MS = 60_000;

export interface ReadModelResidencyBounds {
  readonly maxResidentThreads: number;
  readonly idleTtlMs: number;
  readonly minResidencyMs: number;
  readonly batch: number;
}

export const DEFAULT_READ_MODEL_RESIDENCY_BOUNDS: ReadModelResidencyBounds = {
  maxResidentThreads: READ_MODEL_MAX_RESIDENT_THREADS,
  idleTtlMs: READ_MODEL_THREAD_IDLE_TTL_MS,
  minResidencyMs: READ_MODEL_MIN_RESIDENCY_MS,
  batch: READ_MODEL_EVICTION_BATCH,
};

/** Residency bounds and clock for the engine; tests tighten the bounds and drive the clock. */
export const ReadModelResidencyConfig = ServiceMap.Reference<{
  readonly bounds: ReadModelResidencyBounds;
  readonly nowMs: () => number;
}>("bigbud/orchestration/ReadModelResidencyConfig", {
  defaultValue: () => ({ bounds: DEFAULT_READ_MODEL_RESIDENCY_BOUNDS, nowMs: Date.now }),
});

const ACTIVE_TASK_STATUSES = new Set(["pending", "inProgress"]);

/**
 * True when the in-memory thread carries no work that a restart would resume: no live or
 * starting session, running turn, pending turn start, queued prompt, turn-control operation,
 * interrupt flush, recovery notice, active task, watch, pin, or deletion in progress.
 */
export function isThreadResidentWorkIdle(thread: OrchestrationThread): boolean {
  if (thread.session && thread.session.status !== "stopped") return false;
  if (thread.session?.activeTurnId) return false;
  if (thread.latestTurn?.state === "running") return false;
  if (thread.pendingTurnStart != null) return false;
  if ((thread.queuedPrompts ?? []).length > 0) return false;
  if (thread.pendingTurnControlOperation != null) return false;
  if (thread.pendingInterruptFlushIntent != null) return false;
  if (thread.recovery != null) return false;
  if ((thread.pinnedAt ?? null) !== null) return false;
  if (thread.deletingAt != null) return false;
  if ((thread.tasks ?? []).some((task) => ACTIVE_TASK_STATUSES.has(task.status))) return false;
  if ((thread.watchingThreads ?? []).length > 0) return false;
  return true;
}

/** Last access per resident thread; hydration, accessor hits and commands all touch. */
export function makeThreadResidency(
  bounds: ReadModelResidencyBounds = DEFAULT_READ_MODEL_RESIDENCY_BOUNDS,
  now: () => number = Date.now,
) {
  const lastTouched = new Map<ThreadId, number>();

  const touch = (threadId: ThreadId) => {
    lastTouched.set(threadId, now());
  };
  const forget = (threadId: ThreadId) => {
    lastTouched.delete(threadId);
  };

  /**
   * Least recently used first. A thread first seen here (loaded at startup) counts as touched
   * now. Parents of resident threads are skipped, so ancestor chains stay whole.
   */
  const selectCandidates = (
    threads: ReadonlyArray<OrchestrationThread>,
    nowMs: number = now(),
  ): ReadonlyArray<ThreadId> => {
    const residentIds = new Set<ThreadId>();
    const parentIds = new Set<ThreadId>();
    for (const thread of threads) {
      residentIds.add(thread.id);
      if (thread.parentThread) parentIds.add(thread.parentThread.threadId);
      if (!lastTouched.has(thread.id)) lastTouched.set(thread.id, nowMs);
    }
    for (const threadId of lastTouched.keys()) {
      if (!residentIds.has(threadId)) lastTouched.delete(threadId);
    }
    const idle = threads
      .filter((thread) => !parentIds.has(thread.id) && isThreadResidentWorkIdle(thread))
      .map((thread) => ({ id: thread.id, idleMs: nowMs - (lastTouched.get(thread.id) ?? nowMs) }))
      .filter((entry) => entry.idleMs >= bounds.minResidencyMs)
      .toSorted((left, right) => right.idleMs - left.idleMs);
    const overflow = Math.max(0, threads.length - bounds.maxResidentThreads);
    const selected: Array<ThreadId> = [];
    for (const [index, entry] of idle.entries()) {
      if (selected.length >= bounds.batch) break;
      if (entry.idleMs >= bounds.idleTtlMs || index < overflow) selected.push(entry.id);
    }
    return selected;
  };

  return { touch, forget, selectCandidates, size: () => lastTouched.size } as const;
}

export type ThreadResidency = ReturnType<typeof makeThreadResidency>;

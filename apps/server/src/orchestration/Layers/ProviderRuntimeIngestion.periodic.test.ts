import type { OrchestrationThread } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  makePeriodicReconciliationState,
  PERIODIC_RECONCILIATION_BATCH_SIZE,
  selectPeriodicReconciliationThreads,
} from "./ProviderRuntimeIngestion.periodic.ts";

function runningThread(id: string): OrchestrationThread {
  return {
    id,
    deletedAt: null,
    archivedAt: null,
    pendingInterruptFlushIntent: null,
    session: { status: "running", activeTurnId: "turn" },
  } as unknown as OrchestrationThread;
}

describe("selectPeriodicReconciliationThreads", () => {
  it("rotates bounded selections so threads after the first hundred are not starved", () => {
    const state = makePeriodicReconciliationState();
    const threads = Array.from({ length: 101 }, (_, index) =>
      runningThread(index.toString().padStart(3, "0")),
    );

    const first = selectPeriodicReconciliationThreads(threads, state);
    const second = selectPeriodicReconciliationThreads(threads, state);

    expect(first).toHaveLength(PERIODIC_RECONCILIATION_BATCH_SIZE);
    expect(second).toHaveLength(PERIODIC_RECONCILIATION_BATCH_SIZE);
    expect(first.map((thread) => thread.id)).not.toContain("100");
    expect(second.map((thread) => thread.id)).toContain("100");
  });

  it("skips archived and deleted threads and resets an empty cursor", () => {
    const state = makePeriodicReconciliationState();
    const archived = { ...runningThread("archived"), archivedAt: "2026-01-01T00:00:00.000Z" };
    const deleted = { ...runningThread("deleted"), deletedAt: "2026-01-01T00:00:00.000Z" };

    expect(selectPeriodicReconciliationThreads([archived, deleted], state)).toEqual([]);
    expect(state.cursorThreadId).toBeNull();
  });

  it("does not reconcile sessions that are still starting", () => {
    const state = makePeriodicReconciliationState();
    const running = runningThread("starting");
    const starting: OrchestrationThread = {
      ...running,
      session: { ...running.session!, status: "starting", activeTurnId: null },
    };

    expect(selectPeriodicReconciliationThreads([starting], state)).toEqual([]);
  });

  it("excludes stale idle running sessions until a dirty or audit event opts them in", () => {
    const state = makePeriodicReconciliationState();
    const stale = {
      ...runningThread("stale"),
      session: { status: "running", activeTurnId: null, updatedAt: "2025-01-01T00:00:00.000Z" },
    } as unknown as OrchestrationThread;
    const observedAt = Date.parse("2026-08-01T00:00:00.000Z");

    expect(selectPeriodicReconciliationThreads([stale], state, observedAt)).toEqual([]);
    state.dirtyThreadIds.add(stale.id);
    expect(selectPeriodicReconciliationThreads([stale], state, observedAt)).toEqual([stale]);
  });
});

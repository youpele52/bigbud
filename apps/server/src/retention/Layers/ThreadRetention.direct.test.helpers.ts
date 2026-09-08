import { Effect, Option } from "effect";

import type {
  ThreadRetentionRepositoryShape,
  ThreadRetentionRun,
  ThreadRetentionRunItem,
} from "../../persistence/Services/ThreadRetentionRepository.ts";

export const retentionRun = {
  runId: "retention-direct-run",
  trigger: "manual",
  policy: "1-day",
  cutoffAt: "2026-08-17T00:00:00.000Z",
  status: "selecting",
  cursorLastActivityAt: null,
  cursorThreadId: null,
  eligibleCount: 1,
  selectedCount: 0,
  skippedCount: 0,
  requestedCount: 0,
  completedCount: 0,
  failedCount: 0,
  estimatedResourceCount: 0,
  requiredBaselineSequence: null,
  nextAttemptAt: null,
  lastErrorCode: null,
  retryOrdinal: 0,
  failureWindowStartedAt: null,
  failureCountInWindow: 0,
  lastFailureAt: null,
  circuitOpenUntil: null,
  createdAt: "2026-08-18T00:00:00.000Z",
  startedAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  completedAt: null,
} satisfies ThreadRetentionRun;

export function runnerRepository(
  run: ThreadRetentionRun,
  input: {
    readonly selectNextPage: ThreadRetentionRepositoryShape["selectNextPage"];
    readonly transitionRun?: ThreadRetentionRepositoryShape["transitionRun"];
    readonly transitionItem?: ThreadRetentionRepositoryShape["transitionItem"];
    readonly insertSelectedPage?: ThreadRetentionRepositoryShape["insertSelectedPage"];
    readonly listOutstandingItems?: ThreadRetentionRepositoryShape["listOutstandingItems"];
    readonly findItemByDeletionCommandId?: ThreadRetentionRepositoryShape["findItemByDeletionCommandId"];
  },
) {
  let persistedRun = run;
  let persistedItemStatus: ThreadRetentionRunItem["status"] = "deletion_requested";
  return {
    selectNextPage: input.selectNextPage,
    transitionRun: (transition: Parameters<ThreadRetentionRepositoryShape["transitionRun"]>[0]) =>
      (input.transitionRun?.(transition) ?? Effect.succeed(true)).pipe(
        Effect.tap((changed) =>
          Effect.sync(() => {
            if (changed) persistedRun = { ...persistedRun, status: transition.nextStatus };
          }),
        ),
      ),
    transitionItem: (transition: Parameters<ThreadRetentionRepositoryShape["transitionItem"]>[0]) =>
      (input.transitionItem?.(transition) ?? Effect.succeed(true)).pipe(
        Effect.tap((changed) =>
          Effect.sync(() => {
            if (!changed) return;
            persistedItemStatus = transition.nextStatus;
            persistedRun = {
              ...persistedRun,
              completedCount:
                persistedRun.completedCount + (transition.nextStatus === "completed" ? 1 : 0),
              skippedCount:
                persistedRun.skippedCount + (transition.nextStatus === "skipped" ? 1 : 0),
              failedCount: persistedRun.failedCount + (transition.nextStatus === "failed" ? 1 : 0),
            };
          }),
        ),
      ),
    insertSelectedPage:
      input.insertSelectedPage ??
      (() => Effect.succeed({ applied: true, insertedCount: 1, outstandingBacklogCount: 1 })),
    listRecoverableRuns: () => Effect.succeed([persistedRun]),
    listOutstandingItems: input.listOutstandingItems ?? (() => Effect.succeed([])),
    findItemByDeletionCommandId:
      input.findItemByDeletionCommandId ??
      (() =>
        Effect.succeed(Option.some({ status: persistedItemStatus } as ThreadRetentionRunItem))),
    getRun: () => Effect.succeed(Option.some(persistedRun)),
  } as never;
}

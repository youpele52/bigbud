import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type {
  ThreadRetentionRepositoryShape,
  ThreadRetentionRun,
  ThreadRetentionRunItem,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import { runDirectThreadRetention } from "./ThreadRetention.direct.ts";
import { retentionRun } from "./ThreadRetention.direct.test.helpers.ts";

describe("runDirectThreadRetention resume", () => {
  it("combines persisted progress with current outcomes and reuses the persisted command", async () => {
    const threadId = ThreadId.makeUnsafe("retention-resumed-pending");
    const deletionCommandId = "stable:retention:delete:from-before-restart";
    let progress: ThreadRetentionRun = {
      ...retentionRun,
      eligibleCount: 4,
      selectedCount: 4,
      requestedCount: 3,
      completedCount: 1,
      skippedCount: 1,
      failedCount: 1,
    };
    const outstanding: ThreadRetentionRunItem = {
      runId: progress.runId,
      threadId,
      expectedLastActivityAt: "2026-08-16T00:00:00.000Z",
      deletionCommandId,
      purgeJobId: null,
      status: "deletion_requested",
      exclusionReason: null,
      attemptCount: 1,
      nextAttemptAt: null,
      lastErrorCode: null,
      createdAt: progress.createdAt,
      updatedAt: progress.updatedAt,
      completedAt: null,
    };
    let outstandingDone = false;
    let itemStatus: ThreadRetentionRunItem["status"] = outstanding.status;
    const transitionRun = vi.fn(
      (input: Parameters<ThreadRetentionRepositoryShape["transitionRun"]>[0]) =>
        Effect.sync(() => {
          progress = {
            ...progress,
            status: input.nextStatus,
            updatedAt: input.updatedAt,
            completedAt: input.updatedAt,
          };
          return true;
        }),
    );
    const transitionItem = vi.fn(
      (input: Parameters<ThreadRetentionRepositoryShape["transitionItem"]>[0]) =>
        Effect.sync(() => {
          itemStatus = input.nextStatus;
          if (input.nextStatus === "completed") {
            progress = { ...progress, completedCount: progress.completedCount + 1 };
            outstandingDone = true;
          }
          return true;
        }),
    );
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
    const repository = {
      listRecoverableRuns: () => Effect.succeed([progress]),
      listOutstandingItems: () => Effect.succeed(outstandingDone ? [] : [outstanding]),
      selectNextPage: () => Effect.succeed([]),
      insertSelectedPage: () =>
        Effect.succeed({ applied: true, insertedCount: 0, outstandingBacklogCount: 0 }),
      transitionItem,
      findItemByDeletionCommandId: () =>
        Effect.succeed(Option.some({ ...outstanding, status: itemStatus })),
      transitionRun,
      getRun: () => Effect.succeed(Option.some(progress)),
    } as never;

    const result = await Effect.runPromise(
      runDirectThreadRetention({
        run: progress,
        repository,
        orchestration: {
          dispatch,
          streamDomainEvents: Stream.empty,
          getReadModel: () => Effect.succeed({ threads: [] } as never),
        } as never,
        now: () => Date.parse("2026-08-18T00:00:00.000Z"),
      }),
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: deletionCommandId,
        threadId,
        createdAt: outstanding.createdAt,
      }),
    );
    expect(transitionItem.mock.calls.map(([input]) => input.nextStatus)).toEqual([
      "prepared",
      "purging",
      "completed",
    ]);
    expect(transitionRun).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: "completed_with_failures" }),
    );
    expect(result).toEqual(
      expect.objectContaining({ deletedCount: 2, skippedCount: 1, pendingCount: 1 }),
    );
    expect(progress).toEqual(
      expect.objectContaining({
        status: "completed_with_failures",
        completedCount: 2,
        skippedCount: 1,
        failedCount: 1,
      }),
    );
  });
});

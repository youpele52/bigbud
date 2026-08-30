import { CommandId, type ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ServerThreadRetentionResult } from "@bigbud/contracts/server/threadRetention.ts";
import { Duration, Effect, Option, Ref } from "effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type {
  ThreadRetentionRepositoryShape,
  ThreadRetentionRun,
  ThreadRetentionRunItem,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import { waitForReadModelCondition } from "../../orchestration/Layers/readModelSettle.ts";

const SELECTION_PAGE_SIZE = 250;
const DELETE_SETTLE_TIMEOUT_MS = 120_000;
const OUTSTANDING_ITEM_STATUSES = [
  "selected",
  "deletion_requested",
  "prepared",
  "purging",
] as const;

function settleRetentionDelete(input: {
  readonly threadId: ThreadId;
  readonly orchestration: OrchestrationEngineShape;
  readonly timeoutMs: number;
}) {
  return Effect.gen(function* () {
    const seenPending = yield* Ref.make(false);
    return yield* waitForReadModelCondition({
      check: input.orchestration.getReadModel().pipe(
        Effect.flatMap((model) =>
          Effect.gen(function* () {
            const thread = model.threads.find((candidate) => candidate.id === input.threadId);
            if (!thread || thread.deletedAt !== null) {
              return { done: true as const, value: "deleted" as const };
            }
            if (thread.deletingAt !== null) {
              yield* Ref.set(seenPending, true);
              return { done: false as const };
            }
            if (yield* Ref.get(seenPending)) {
              return { done: true as const, value: "skipped" as const };
            }
            return { done: false as const };
          }),
        ),
      ),
      events: input.orchestration.streamDomainEvents,
      timeout: Duration.millis(input.timeoutMs),
      onTimeout: "pending" as const,
    });
  });
}

type DirectThreadRetentionInput = {
  readonly run: ThreadRetentionRun;
  readonly repository: Pick<
    ThreadRetentionRepositoryShape,
    | "selectNextPage"
    | "insertSelectedPage"
    | "transitionRun"
    | "listRecoverableRuns"
    | "listOutstandingItems"
    | "getRun"
    | "findItemByDeletionCommandId"
    | "transitionItem"
  >;
  readonly orchestration: OrchestrationEngineShape;
  readonly now?: () => number;
  readonly settleTimeoutMs?: number;
};

type CoordinatedDirectThreadRetentionInput = DirectThreadRetentionInput & {
  readonly onSelectionPagePersisted: () => Effect.Effect<boolean, ProjectionRepositoryError>;
};

export function runDirectThreadRetentionCoordinated(
  input: CoordinatedDirectThreadRetentionInput,
): Effect.Effect<
  | { readonly kind: "completed"; readonly result: ServerThreadRetentionResult }
  | { readonly kind: "yielded" },
  ProjectionRepositoryError | OrchestrationDispatchError | Error
> {
  return Effect.gen(function* () {
    const now = input.now ?? Date.now;
    const startedAt = now();
    const cutoffAt = input.run.cutoffAt;
    const createdAt = new Date(startedAt).toISOString();
    const settleTimeoutMs = input.settleTimeoutMs ?? DELETE_SETTLE_TIMEOUT_MS;
    const owned = (yield* input.repository.listRecoverableRuns(100)).some(
      (candidate) => candidate.runId === input.run.runId,
    );
    if (!owned)
      return yield* Effect.fail(new Error("retention run active-slot ownership was lost"));
    if (input.run.status !== "selecting") {
      const transitioned = yield* input.repository.transitionRun({
        runId: input.run.runId,
        expectedStatuses: [input.run.status],
        nextStatus: "selecting",
        updatedAt: createdAt,
      });
      if (!transitioned) {
        return yield* Effect.fail(new Error("retention run could not enter selection"));
      }
    }
    let cursor: { readonly lastActivityAt: string; readonly threadId: ThreadId } | undefined =
      input.run.cursorLastActivityAt && input.run.cursorThreadId
        ? {
            lastActivityAt: input.run.cursorLastActivityAt,
            threadId: input.run.cursorThreadId,
          }
        : undefined;
    let eligibleCount = input.run.eligibleCount;
    let selectedCount = input.run.selectedCount;

    const executeItem = Effect.fn("ThreadRetention.executeItem")(function* (
      item: Pick<
        ThreadRetentionRunItem,
        "threadId" | "expectedLastActivityAt" | "deletionCommandId" | "createdAt"
      >,
    ) {
      yield* input.orchestration.getReadModel();
      yield* input.orchestration.dispatch({
        type: "thread.retention-delete",
        commandId: CommandId.makeUnsafe(item.deletionCommandId),
        threadId: item.threadId,
        runId: input.run.runId,
        expectedLastActivityAt: item.expectedLastActivityAt,
        cutoffAt,
        createdAt: item.createdAt,
      });
      const settled = yield* settleRetentionDelete({
        threadId: item.threadId,
        orchestration: input.orchestration,
        timeoutMs: settleTimeoutMs,
      });
      const persistedItem = yield* input.repository.findItemByDeletionCommandId(
        item.deletionCommandId,
      );
      if (Option.isNone(persistedItem)) {
        return yield* Effect.fail(new Error("retention item disappeared after deletion dispatch"));
      }
      let status = persistedItem.value.status;
      const transition = Effect.fn("ThreadRetention.transitionItemRequired")(function* (
        nextStatus: ThreadRetentionRunItem["status"],
        lastErrorCode: string | null = null,
      ) {
        const previousStatus = status;
        const changed = yield* input.repository.transitionItem({
          runId: input.run.runId,
          threadId: item.threadId,
          expectedStatuses: [previousStatus],
          nextStatus,
          updatedAt: new Date(now()).toISOString(),
          lastErrorCode,
        });
        if (!changed) {
          return yield* Effect.fail(
            new Error(
              `retention item transition lost ownership or state: ${previousStatus} -> ${nextStatus}`,
            ),
          );
        }
        status = nextStatus;
      });

      if (settled === "deleted") {
        if (status === "deletion_requested") yield* transition("prepared");
        if (status === "prepared") yield* transition("purging");
        if (status === "purging") yield* transition("completed");
        if (status !== "completed") {
          return yield* Effect.fail(
            new Error(`retention deleted item has incompatible persisted status: ${status}`),
          );
        }
      } else if (settled === "skipped") {
        if (status === "selected" || status === "deletion_requested") yield* transition("skipped");
        if (status !== "skipped") {
          return yield* Effect.fail(
            new Error(`retention skipped item has incompatible persisted status: ${status}`),
          );
        }
      } else {
        if (
          OUTSTANDING_ITEM_STATUSES.includes(status as (typeof OUTSTANDING_ITEM_STATUSES)[number])
        )
          yield* transition("failed", "deletion_pending");
        if (status !== "failed") {
          return yield* Effect.fail(
            new Error(`retention pending item has incompatible persisted status: ${status}`),
          );
        }
      }
    });

    while (true) {
      const outstanding = yield* input.repository.listOutstandingItems(input.run.runId, 250);
      if (outstanding.length === 0) break;
      yield* Effect.forEach(outstanding, executeItem, { concurrency: 1, discard: true });
    }

    while (true) {
      const candidates = yield* input.repository.selectNextPage({
        cutoffAt,
        ...(cursor ? { cursor } : {}),
        limit: SELECTION_PAGE_SIZE,
      });
      if (candidates.length === 0) break;
      const nextCursor = candidates.at(-1)!;
      const items = candidates.map((candidate) => ({
        threadId: candidate.threadId,
        expectedLastActivityAt: candidate.lastActivityAt,
        deletionCommandId: `server:thread-retention-delete:${input.run.runId}:${candidate.threadId}`,
        createdAt,
      }));
      const inserted = yield* input.repository.insertSelectedPage({
        runId: input.run.runId,
        candidates: candidates.map((candidate, index) => ({
          threadId: candidate.threadId,
          lastActivityAt: candidate.lastActivityAt,
          deletionCommandId: items[index]!.deletionCommandId,
        })),
        createdAt,
        expectedStatus: "selecting",
        expectedCursor: cursor ?? null,
        nextCursor,
      });
      if (!inserted.applied) {
        return yield* Effect.fail(new Error("retention selection cursor ownership was lost"));
      }
      cursor = nextCursor;
      selectedCount += inserted.insertedCount;
      eligibleCount = Math.max(eligibleCount, selectedCount);
      if (yield* input.onSelectionPagePersisted()) return { kind: "yielded" } as const;
      yield* Effect.forEach(items, executeItem, { concurrency: 1, discard: true });
    }

    const persistedProgress = yield* input.repository.getRun(input.run.runId);
    if (Option.isNone(persistedProgress)) {
      return yield* Effect.fail(new Error("retention run disappeared before completion"));
    }
    const progress = persistedProgress.value;
    const completedAt = new Date(now()).toISOString();
    const completedWithFailures = progress.skippedCount > 0 || progress.failedCount > 0;
    if (completedWithFailures) {
      const preparing = yield* input.repository.transitionRun({
        runId: input.run.runId,
        expectedStatuses: ["selecting"],
        nextStatus: "preparing",
        updatedAt: completedAt,
        eligibleCount,
      });
      if (!preparing) {
        return yield* Effect.fail(
          new Error("retention preparing transition lost active-slot ownership"),
        );
      }
    }
    const terminal = yield* input.repository.transitionRun({
      runId: input.run.runId,
      expectedStatuses: [completedWithFailures ? "preparing" : "selecting"],
      nextStatus: completedWithFailures ? "completed_with_failures" : "completed",
      updatedAt: completedAt,
      ...(completedWithFailures ? {} : { eligibleCount }),
    });
    if (!terminal) {
      return yield* Effect.fail(
        new Error("retention terminal transition lost active-slot ownership"),
      );
    }
    const persistedCompletion = yield* input.repository.getRun(input.run.runId);
    if (Option.isNone(persistedCompletion)) {
      return yield* Effect.fail(new Error("retention run disappeared after completion"));
    }
    const completedRun = persistedCompletion.value;

    return {
      kind: "completed",
      result: {
        trigger: completedRun.trigger,
        policy: completedRun.policy,
        cutoffAt: completedRun.cutoffAt,
        eligibleCount: completedRun.eligibleCount,
        deletedCount: completedRun.completedCount,
        skippedCount: completedRun.skippedCount,
        pendingCount: completedRun.failedCount,
        completedAt: completedRun.completedAt ?? completedAt,
      },
    } as const;
  });
}

export function runDirectThreadRetention(
  input: DirectThreadRetentionInput,
): Effect.Effect<
  ServerThreadRetentionResult,
  ProjectionRepositoryError | OrchestrationDispatchError | Error
> {
  return runDirectThreadRetentionCoordinated({
    ...input,
    onSelectionPagePersisted: () => Effect.succeed(false),
  }).pipe(
    Effect.flatMap((execution) =>
      execution.kind === "completed"
        ? Effect.succeed(execution.result)
        : Effect.fail(new Error("uncoordinated retention run yielded")),
    ),
  );
}

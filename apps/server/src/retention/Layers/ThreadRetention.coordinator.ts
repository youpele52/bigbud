import type { ServerThreadRetentionResult } from "@bigbud/contracts/server/threadRetention.ts";
import { Effect, Option, Semaphore } from "effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  isThreadRetentionTerminalRunStatus,
  type ThreadRetentionRepositoryShape,
  type ThreadRetentionRun,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import { runDirectThreadRetentionCoordinated } from "./ThreadRetention.direct.ts";

const MANUAL_PURGE_BACKLOG_LIMIT = 100;

function persistedResult(run: ThreadRetentionRun): ServerThreadRetentionResult {
  return {
    trigger: run.trigger,
    policy: run.policy,
    cutoffAt: run.cutoffAt,
    eligibleCount: run.eligibleCount,
    deletedCount: run.completedCount,
    skippedCount: run.skippedCount,
    pendingCount: run.failedCount,
    completedAt: run.completedAt ?? run.updatedAt,
  };
}

export const makeThreadRetentionExecutionCoordinator = Effect.fn(
  "ThreadRetention.makeExecutionCoordinator",
)(function* (input: {
  readonly repository: ThreadRetentionRepositoryShape;
  readonly orchestration: OrchestrationEngineShape;
}) {
  const permit = yield* Semaphore.make(1);

  const yieldScheduledRunToManual = (active: ThreadRetentionRun) =>
    Effect.gen(function* () {
      if (active.trigger !== "scheduled") return Option.none<ThreadRetentionRun>();
      const manual = (yield* input.repository.listQueuedManualRuns(1))[0];
      if (!manual) return Option.none<ThreadRetentionRun>();
      return yield* input.repository.yieldActiveRunToManual(
        active.runId,
        manual.runId,
        new Date().toISOString(),
        MANUAL_PURGE_BACKLOG_LIMIT,
      );
    });

  const drain = (targetRunId?: string) =>
    permit.withPermits(1)(
      Effect.gen(function* () {
        for (;;) {
          if (targetRunId) {
            const target = yield* input.repository.getRun(targetRunId);
            if (Option.isNone(target)) {
              return yield* Effect.fail(new Error("retention run was not persisted"));
            }
            if (isThreadRetentionTerminalRunStatus(target.value.status)) {
              return persistedResult(target.value);
            }
          }

          let active = (yield* input.repository.listRecoverableRuns(1))[0];
          if (active) {
            const yielded = yield* yieldScheduledRunToManual(active);
            if (Option.isSome(yielded)) active = yielded.value;
          }
          if (!active) {
            const claimed = yield* input.repository.claimNextQueuedRun(new Date().toISOString());
            active = Option.getOrUndefined(claimed);
          }
          if (!active) {
            if (targetRunId) {
              return yield* Effect.fail(
                new Error("retention run is waiting without active-slot ownership"),
              );
            }
            return undefined;
          }

          const execution = yield* runDirectThreadRetentionCoordinated({
            run: active,
            repository: input.repository,
            orchestration: input.orchestration,
            onSelectionPagePersisted: () =>
              yieldScheduledRunToManual(active).pipe(Effect.map(Option.isSome)),
          });
          if (execution.kind === "yielded") continue;
          if (active.runId === targetRunId) return execution.result;
        }
      }),
    );

  const execute = (runId: string) =>
    drain(runId).pipe(
      Effect.flatMap((result) =>
        result
          ? Effect.succeed(result)
          : Effect.fail(new Error("retention run completed without a result")),
      ),
    );

  return { drain: () => drain(), execute };
});

import { Effect, Option, Ref } from "effect";

import type { PurgeJobRepositoryShape } from "../../persistence/Services/PurgeJobRepository.ts";
import type {
  ThreadRetentionRepositoryShape,
  ThreadRetentionRun,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import { isThreadRetentionNonterminalRunStatus } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { retentionItemRetryIsDue } from "./ThreadRetention.coordinator.helpers.ts";

export type ThreadRetentionWork =
  | { readonly _tag: "normal" }
  | { readonly _tag: "freshManual"; readonly runId: string };

export const normalThreadRetentionWork: ThreadRetentionWork = { _tag: "normal" };
export const FRESH_MANUAL_RETRY_DELAY_MS = 1_000;

export function forgetFreshManualRun(input: {
  readonly runId: string;
  readonly freshManualRunIds: Ref.Ref<ReadonlyArray<string>>;
  readonly cancelWake: (runId: string) => Effect.Effect<void>;
}) {
  return Ref.update(input.freshManualRunIds, (runIds) =>
    runIds.filter((candidate) => candidate !== input.runId),
  ).pipe(Effect.andThen(input.cancelWake(input.runId)));
}

export function processThreadRetentionWork<E>(input: {
  readonly work: ThreadRetentionWork;
  readonly maintenanceReadyAt: Ref.Ref<number | null>;
  readonly freshManualRunIds: Ref.Ref<ReadonlyArray<string>>;
  readonly repository: Pick<
    ThreadRetentionRepositoryShape,
    | "claimNextQueuedRun"
    | "claimQueuedManualRun"
    | "getRun"
    | "listQueuedManualRuns"
    | "listOutstandingItems"
    | "listRecoverableRuns"
    | "yieldActiveRunToManual"
  >;
  readonly purgeJobs: Pick<PurgeJobRepositoryShape, "countIncomplete">;
  readonly purgeBacklogLimit: number;
  readonly processQueuedRun: (runId: string) => Effect.Effect<void, E>;
  readonly scheduleFreshManualWake: (runId: string, wakeAt: string) => Effect.Effect<void>;
  readonly cancelWake: (runId: string) => Effect.Effect<void>;
  readonly now?: () => number;
}) {
  return Effect.gen(function* () {
    const now = input.now ?? Date.now;
    if (input.work._tag === "freshManual") {
      const runId = input.work.runId;
      yield* Ref.update(input.freshManualRunIds, (runIds) =>
        runIds.includes(runId) ? runIds : [...runIds, runId],
      );
    }
    const forgetFreshManual = (runId: string) =>
      forgetFreshManualRun({
        runId,
        freshManualRunIds: input.freshManualRunIds,
        cancelWake: input.cancelWake,
      });
    const scheduleFreshManualRetry = (
      work: Extract<ThreadRetentionWork, { _tag: "freshManual" }>,
    ) =>
      Effect.gen(function* () {
        const current = yield* input.repository.getRun(work.runId);
        if (Option.isSome(current) && isThreadRetentionNonterminalRunStatus(current.value.status)) {
          const retryAt = new Date(now() + FRESH_MANUAL_RETRY_DELAY_MS).toISOString();
          yield* input.scheduleFreshManualWake(
            work.runId,
            current.value.nextAttemptAt !== null && current.value.nextAttemptAt > retryAt
              ? current.value.nextAttemptAt
              : retryAt,
          );
        } else {
          yield* forgetFreshManual(work.runId);
        }
      });
    const readyAt = yield* Ref.get(input.maintenanceReadyAt);
    const maintenanceReady = readyAt !== null && now() >= readyAt;
    const active = yield* input.repository.listRecoverableRuns(1);
    if (active[0]) {
      let queuedManualRuns = [] as ReadonlyArray<ThreadRetentionRun>;
      if (input.work._tag === "normal" && active[0].trigger === "scheduled") {
        queuedManualRuns = yield* input.repository.listQueuedManualRuns(1);
      }
      const persistedManual = queuedManualRuns[0];
      if (input.work._tag === "freshManual" && active[0].runId === input.work.runId) {
        yield* input.processQueuedRun(active[0].runId);
      } else if (input.work._tag === "freshManual" && active[0].trigger === "scheduled") {
        const outstanding = yield* input.repository.listOutstandingItems(active[0].runId, 250);
        const nowIso = new Date(now()).toISOString();
        if (
          outstanding.some(
            (item) =>
              retentionItemRetryIsDue(item, nowIso) &&
              ["deletion_requested", "prepared", "purging"].includes(item.status),
          )
        ) {
          yield* input.processQueuedRun(active[0].runId);
        }
        const claimedAt = new Date(now()).toISOString();
        let manual = yield* input.repository.yieldActiveRunToManual(
          active[0].runId,
          input.work.runId,
          claimedAt,
          input.purgeBacklogLimit,
        );
        if (Option.isNone(manual)) {
          manual = yield* input.repository.claimQueuedManualRun(
            input.work.runId,
            claimedAt,
            input.purgeBacklogLimit,
          );
        }
        if (Option.isSome(manual)) yield* input.processQueuedRun(manual.value.runId);
        else yield* scheduleFreshManualRetry(input.work);
      } else if (persistedManual) {
        if (!maintenanceReady) return;
        yield* input.processQueuedRun(active[0].runId);
        const claimedAt = new Date(now()).toISOString();
        let manual = yield* input.repository.yieldActiveRunToManual(
          active[0].runId,
          persistedManual.runId,
          claimedAt,
          input.purgeBacklogLimit,
        );
        if (Option.isNone(manual)) {
          manual = yield* input.repository.claimQueuedManualRun(
            persistedManual.runId,
            claimedAt,
            input.purgeBacklogLimit,
          );
        }
        if (Option.isSome(manual)) yield* input.processQueuedRun(manual.value.runId);
      } else {
        if (maintenanceReady) yield* input.processQueuedRun(active[0].runId);
        if (input.work._tag === "freshManual") yield* scheduleFreshManualRetry(input.work);
      }
      return;
    }

    const pendingFreshManualRunId = (yield* Ref.get(input.freshManualRunIds))[0];
    const work =
      input.work._tag === "normal" && pendingFreshManualRunId !== undefined
        ? ({ _tag: "freshManual", runId: pendingFreshManualRunId } as const)
        : input.work;
    if (work._tag === "normal" && !maintenanceReady) return;
    if ((yield* input.purgeJobs.countIncomplete()) >= input.purgeBacklogLimit) {
      if (work._tag === "freshManual") yield* scheduleFreshManualRetry(work);
      return;
    }

    const claimedAt = new Date(now()).toISOString();
    const run =
      work._tag === "freshManual"
        ? yield* input.repository.claimQueuedManualRun(
            work.runId,
            claimedAt,
            input.purgeBacklogLimit,
          )
        : yield* input.repository.claimNextQueuedRun(claimedAt);
    if (Option.isSome(run)) {
      yield* input.processQueuedRun(run.value.runId);
    } else if (work._tag === "freshManual") {
      yield* scheduleFreshManualRetry(work);
    }
  });
}

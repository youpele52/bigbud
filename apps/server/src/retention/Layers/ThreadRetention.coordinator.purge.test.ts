import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";

import type { EntityPurgeShape } from "../../deletion/Services/EntityPurge.ts";
import type { PurgeJobRepositoryShape } from "../../persistence/Services/PurgeJobRepository.ts";
import type { PurgeJob } from "../../persistence/Services/PurgeJobRepository.ts";
import type {
  ThreadRetentionRepositoryShape,
  ThreadRetentionRunItem,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import { makePurgePreparedRetentionItems } from "./ThreadRetention.coordinator.purge.ts";

it.effect("runs failed purge recovery before newly prepared work", () =>
  Effect.gen(function* () {
    const calls = new Map<string, number>();
    const batchOrder: Array<string> = [];
    const jobs = {
      failed: { jobId: "failed", entityId: "failed-thread", status: "failed" },
      pending: { jobId: "pending", entityId: "pending-thread", status: "pending" },
    } as const;
    const purge = makePurgePreparedRetentionItems({
      repository: {
        transitionItem: () => Effect.succeed(true),
      } as unknown as ThreadRetentionRepositoryShape,
      purgeJobs: {
        findIncomplete: ({ entityId }: { readonly entityId: string }) =>
          Effect.sync(() => {
            const count = calls.get(entityId) ?? 0;
            calls.set(entityId, count + 1);
            if (count > 0) return Option.none();
            return Option.some(
              entityId === "failed-thread" ? jobs.failed : (jobs.pending as never),
            );
          }),
        findById: (jobId: string) =>
          Effect.succeed(Option.some({ jobId, status: "completed" } as never)),
      } as unknown as PurgeJobRepositoryShape,
      entityPurge: {
        runBatch: (batch: ReadonlyArray<PurgeJob>) =>
          Effect.sync(() => {
            batchOrder.push(...batch.map((job: PurgeJob) => job.jobId));
          }),
      } as unknown as EntityPurgeShape,
    });
    const item = (threadId: string, status: "prepared" | "purging") =>
      ({ threadId: ThreadId.makeUnsafe(threadId), status }) as ThreadRetentionRunItem;

    yield* purge({ runId: "run" } as never, [
      item("pending-thread", "prepared"),
      item("failed-thread", "purging"),
    ]);

    assert.deepEqual(batchOrder, ["failed", "pending"]);
  }),
);

it.effect("does not treat missing purge evidence as successful deletion", () =>
  Effect.gen(function* () {
    let completed = false;
    const purge = makePurgePreparedRetentionItems({
      repository: {
        transitionItem: (input: { readonly nextStatus: string }) =>
          Effect.sync(() => {
            if (input.nextStatus === "completed") completed = true;
            return true;
          }),
      } as unknown as ThreadRetentionRepositoryShape,
      purgeJobs: {
        findIncomplete: () => Effect.succeed(Option.none()),
        findById: () => Effect.succeed(Option.none()),
      } as unknown as PurgeJobRepositoryShape,
      entityPurge: { runBatch: () => Effect.void } as unknown as EntityPurgeShape,
    });

    const result = yield* purge({ runId: "run" } as never, [
      {
        threadId: ThreadId.makeUnsafe("missing-evidence"),
        status: "purging",
        purgeJobId: "missing-job",
      } as ThreadRetentionRunItem,
    ]);

    assert.equal(result, "pending");
    assert.isFalse(completed);
  }),
);

it.effect("terminalizes a manual-recovery job excluded from incomplete work", () =>
  Effect.gen(function* () {
    const transitions: Array<{ readonly lastErrorCode?: string; readonly nextStatus: string }> = [];
    let batchRan = false;
    const purge = makePurgePreparedRetentionItems({
      repository: {
        transitionItem: (input: { readonly lastErrorCode?: string; readonly nextStatus: string }) =>
          Effect.sync(() => {
            transitions.push(input);
            return true;
          }),
      } as unknown as ThreadRetentionRepositoryShape,
      purgeJobs: {
        findIncomplete: () => Effect.succeed(Option.none()),
        findById: () =>
          Effect.succeed(Option.some({ lastError: "manual_recovery_required" } as never)),
      } as unknown as PurgeJobRepositoryShape,
      entityPurge: {
        runBatch: () =>
          Effect.sync(() => {
            batchRan = true;
          }),
      } as unknown as EntityPurgeShape,
    });

    const complete = yield* purge({ runId: "run" } as never, [
      {
        threadId: ThreadId.makeUnsafe("manual-recovery-thread"),
        status: "prepared",
        purgeJobId: "manual-recovery-job",
      } as ThreadRetentionRunItem,
    ]);

    assert.equal(complete, "complete");
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0]?.nextStatus, "failed");
    assert.equal(transitions[0]?.lastErrorCode, "manual_recovery_required");
    assert.isFalse(batchRan);
  }),
);

it.effect("marks an item failed when its purge retry ceiling is exhausted", () =>
  Effect.gen(function* () {
    let nextStatus: string | null = null;
    let batchRan = false;
    const purge = makePurgePreparedRetentionItems({
      repository: {
        transitionItem: (input: { readonly nextStatus: string }) =>
          Effect.sync(() => {
            nextStatus = input.nextStatus;
            return true;
          }),
      } as unknown as ThreadRetentionRepositoryShape,
      purgeJobs: {
        findIncomplete: () =>
          Effect.succeed(
            Option.some({
              jobId: "exhausted-job",
              entityId: "exhausted-thread",
              status: "failed",
              attemptCount: 5,
            } as never),
          ),
      } as unknown as PurgeJobRepositoryShape,
      entityPurge: {
        runBatch: () =>
          Effect.sync(() => {
            batchRan = true;
          }),
      } as unknown as EntityPurgeShape,
    });

    const complete = yield* purge({ runId: "run" } as never, [
      {
        threadId: ThreadId.makeUnsafe("exhausted-thread"),
        status: "purging",
      } as ThreadRetentionRunItem,
    ]);

    assert.equal(complete, "complete");
    assert.equal(nextStatus, "failed");
    assert.isFalse(batchRan);
  }),
);

it.effect("interrupts purge work at the retention slice deadline", () =>
  Effect.gen(function* () {
    const purge = makePurgePreparedRetentionItems({
      repository: {
        transitionItem: () => Effect.succeed(true),
      } as unknown as ThreadRetentionRepositoryShape,
      purgeJobs: {
        findIncomplete: () =>
          Effect.succeed(
            Option.some({
              jobId: "deadline-job",
              entityId: "deadline-thread",
              status: "pending",
              attemptCount: 0,
            } as never),
          ),
      } as unknown as PurgeJobRepositoryShape,
      entityPurge: { runBatch: () => Effect.never } as unknown as EntityPurgeShape,
    });
    const fiber = yield* purge(
      { runId: "deadline-run" } as never,
      [
        {
          threadId: ThreadId.makeUnsafe("deadline-thread"),
          status: "prepared",
        } as ThreadRetentionRunItem,
      ],
      30_000,
      () => 0,
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(30_000));
    assert.equal(yield* Fiber.join(fiber), "timeout");
  }),
);

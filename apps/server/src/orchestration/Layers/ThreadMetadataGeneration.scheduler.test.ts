import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { ThreadMetadataGenerationRepository } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import type { MetadataGenerationJob } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import {
  capturedTitle,
  coordinatorTestLayer,
  initialTime,
  makeCoordinatorFixture,
} from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";
import { makeMetadataJobInput } from "./ThreadMetadataGeneration.jobs.ts";
import { makeMetadataScheduler } from "./ThreadMetadataGeneration.scheduler.ts";

const settle = Effect.gen(function* () {
  for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
});
const jobs = (count: number): MetadataGenerationJob[] =>
  Array.from({ length: count }, (_, index) => ({
    ...makeMetadataJobInput({
      context: capturedTitle(),
      generationKey: String(index),
      at: initialTime,
    }),
    jobId: `job-${String(index).padStart(4, "0")}`,
    state: "pending",
    revision: 0,
  }));
const page = (
  rows: ReadonlyArray<MetadataGenerationJob>,
  query: { afterJobId?: string; limit: number },
) => rows.filter((row) => row.jobId > (query.afterJobId ?? "")).slice(0, query.limit);

it.effect(
  "bounds active workers, prevents duplicate local dispatch and advances the SQL cursor",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rows = jobs(5);
        const release = yield* Deferred.make<void>();
        const calls: string[] = [];
        const queries: Array<{ afterJobId?: string; limit: number }> = [];
        const scheduler = yield* makeMetadataScheduler({
          now: () => initialTime,
          repository: {
            listDue: (query) =>
              Effect.sync(() => {
                queries.push(query);
                return page(rows, query);
              }),
          },
          step: (jobId) =>
            Effect.sync(() => {
              calls.push(jobId);
            }).pipe(Effect.andThen(Deferred.await(release))),
        });
        yield* Effect.all([scheduler.poll(), scheduler.poll()], { concurrency: 2 });
        yield* settle;
        assert.deepEqual(calls, ["job-0000", "job-0001"]);
        yield* scheduler.poll();
        assert.equal(queries.length, 1);
        yield* Deferred.succeed(release, undefined);
        yield* settle;
        yield* scheduler.poll();
        yield* settle;
        assert.equal(queries[1]?.afterJobId, "job-0001");
        assert.isTrue(calls.includes("job-0002"));
        assert.isTrue(queries.every((query) => query.limit === 100));
      }),
    ),
);

it.effect("walks beyond a full page and wraps so newly due earlier jobs are not starved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const rows = jobs(105);
      const calls: string[] = [];
      const cursors: string[] = [];
      const scheduler = yield* makeMetadataScheduler({
        now: () => initialTime,
        repository: {
          listDue: (query) =>
            Effect.sync(() => {
              cursors.push(query.afterJobId ?? "");
              return page(rows, query);
            }),
        },
        step: (jobId) =>
          Effect.sync(() => {
            calls.push(jobId);
          }),
      });
      for (let index = 0; index < 110; index += 1) {
        yield* scheduler.poll();
        yield* settle;
      }
      assert.equal(new Set(calls).size, rows.length);
      assert.isTrue(cursors.slice(1).includes(""));
    }),
  ),
);

it.effect("retries failed scans, starts only once, and releases slots after worker defects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let queries = 0;
      let calls = 0;
      const scheduler = yield* makeMetadataScheduler({
        now: () => initialTime,
        repository: {
          listDue: () =>
            Effect.suspend(() => {
              queries += 1;
              return queries === 1
                ? Effect.fail(new PersistenceSqlError({ operation: "listDue", detail: "busy" }))
                : Effect.succeed(jobs(1));
            }),
        },
        step: () =>
          Effect.sync(() => {
            calls += 1;
          }).pipe(Effect.andThen(Effect.die("private failure"))),
      });
      yield* scheduler.start();
      yield* scheduler.start();
      yield* settle;
      assert.equal(queries, 1);
      yield* TestClock.adjust("2 seconds");
      yield* settle;
      assert.equal(queries, 2);
      assert.equal(calls, 1);
      yield* TestClock.adjust("2 seconds");
      yield* settle;
      assert.equal(calls, 2);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("scope shutdown interrupts workers rather than leaving detached work", () =>
  Effect.gen(function* () {
    let interrupted = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const scheduler = yield* makeMetadataScheduler({
          now: () => initialTime,
          repository: { listDue: () => Effect.succeed(jobs(2)) },
          step: () =>
            Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  interrupted += 1;
                }),
              ),
            ),
        });
        yield* scheduler.poll();
        yield* settle;
      }),
    );
    assert.equal(interrupted, 2);
  }),
);

it.effect("execution timeout frees a slot but cannot release durable paid-work uncertainty", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const repository = yield* ThreadMetadataGenerationRepository;
      const f = makeCoordinatorFixture(repository);
      const job = yield* f.create();
      let steps = 0;
      const scheduler = yield* makeMetadataScheduler({
        now: () => f.control.at,
        repository,
        step: (jobId) =>
          Effect.gen(function* () {
            steps += 1;
            if (steps === 1) {
              f.control.outcome = "defect";
              yield* f.coordinator.step(jobId).pipe(Effect.catchCause(() => Effect.void));
              return yield* Effect.never;
            } else yield* f.coordinator.step(jobId);
          }),
      });
      yield* scheduler.poll();
      yield* settle;
      yield* TestClock.adjust("190 seconds");
      yield* settle;
      // Advance beyond all captured deadlines. Time alone is never evidence of no dispatch.
      f.advance(3_600_000);
      yield* scheduler.poll();
      yield* settle;
      yield* scheduler.poll();
      yield* settle;
      assert.equal(steps, 3);
      assert.equal(f.control.calls.length, 1);
      assert.equal((yield* repository.listAttempts(job.jobId))[0]?.state, "dispatch-intent");
    }),
  ).pipe(Effect.provide(Layer.mergeAll(coordinatorTestLayer, TestClock.layer()))),
);

import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { ThreadMetadataGenerationRepository } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import type { ThreadMetadataGenerationRepositoryShape } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import {
  coordinatorTestLayer,
  makeCoordinatorFixture,
} from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";

const lostWrite = () =>
  new PersistenceSqlError({ operation: "settleAttempt", detail: "Simulated unavailable SQL" });

it.layer(coordinatorTestLayer)("metadata outcome persistence", (it) => {
  for (const fault of ["before-write", "after-write", "read", "cas"] as const) {
    it.effect(`retains output and retries SQL only after ${fault} failure`, () =>
      Effect.gen(function* () {
        const r = yield* ThreadMetadataGenerationRepository;
        const failed = yield* Deferred.make<void>();
        let writes = 0;
        let failRead = fault === "read";
        let readyToRead = false;
        const repository: ThreadMetadataGenerationRepositoryShape = {
          ...r,
          claimDispatch: (attempt, at) =>
            r.claimDispatch(attempt, at).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  readyToRead = true;
                }),
              ),
            ),
          listAttempts: (jobId) =>
            Effect.gen(function* () {
              if (readyToRead && failRead) {
                failRead = false;
                yield* Deferred.succeed(failed, undefined);
                return yield* lostWrite();
              }
              return yield* r.listAttempts(jobId);
            }),
          settleAttempt: (input) =>
            Effect.gen(function* () {
              writes += 1;
              if (writes === 1 && fault !== "read") {
                if (fault === "after-write") yield* r.settleAttempt(input);
                yield* Deferred.succeed(failed, undefined);
                if (fault === "cas") return false;
                return yield* lostWrite();
              }
              return yield* r.settleAttempt(input);
            }),
        };
        const f = makeCoordinatorFixture(repository);
        f.control.outcome = "success";
        const job = yield* f.create();
        const worker = yield* Effect.forkChild(f.coordinator.step(job.jobId));
        yield* Deferred.await(failed);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(worker);
        const [attempt] = yield* r.listAttempts(job.jobId);
        assert.strictEqual(attempt?.state, "result-ready");
        assert.strictEqual(attempt?.result, "Repair durable metadata recovery");
        assert.strictEqual(f.control.calls.length, 1);
        assert.strictEqual(writes, fault === "before-write" || fault === "cas" ? 2 : 1);
        yield* f.coordinator.step(job.jobId);
        assert.strictEqual(f.control.calls.length, 1);
        assert.strictEqual((yield* r.listAttempts(job.jobId))[0]?.state, "completed");
      }),
    );
  }

  it.effect("bounds unavailable SQL retries and leaves a permanent dispatch barrier", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const failed = yield* Deferred.make<void>();
      let writes = 0;
      const repository: ThreadMetadataGenerationRepositoryShape = {
        ...r,
        settleAttempt: () =>
          Effect.gen(function* () {
            writes += 1;
            yield* Deferred.succeed(failed, undefined);
            return yield* lostWrite();
          }),
      };
      const f = makeCoordinatorFixture(repository);
      f.control.outcome = "success";
      const job = yield* f.create();
      const worker = yield* Effect.forkChild(f.coordinator.step(job.jobId).pipe(Effect.result));
      yield* Deferred.await(failed);
      yield* TestClock.adjust("1 second");
      assert.strictEqual((yield* Fiber.join(worker))._tag, "Failure");
      assert.strictEqual(writes, 4);
      assert.strictEqual((yield* r.listAttempts(job.jobId))[0]?.state, "dispatch-intent");
      f.advance(86_400_000);
      yield* f.coordinator.step(job.jobId);
      assert.strictEqual(f.control.calls.length, 1);
      assert.strictEqual((yield* r.listAttempts(job.jobId)).length, 1);
    }),
  );
});

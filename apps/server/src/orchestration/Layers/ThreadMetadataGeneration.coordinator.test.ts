import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { ThreadMetadataGenerationRepository } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import { makeMetadataCoordinator } from "./ThreadMetadataGeneration.coordinator.ts";
import {
  capturedTitle,
  coordinatorTestLayer,
  makeCoordinatorFixture,
} from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";

it.layer(coordinatorTestLayer)("durable metadata coordinator", (it) => {
  it.effect("bounds two primary failures and one verified failure across restarts", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const f = makeCoordinatorFixture(r);
      const job = yield* f.create();
      const step = () =>
        makeMetadataCoordinator({
          repository: r,
          textGeneration: f.textGeneration,
          host: f.host,
        }).step(job.jobId);
      yield* step();
      yield* step();
      assert.deepStrictEqual(f.control.calls, ["configured"]);
      f.advance(1_999);
      yield* step();
      assert.strictEqual(f.control.calls.length, 1);
      f.advance(1);
      yield* step();
      yield* step();
      assert.deepStrictEqual(f.control.calls, ["configured", "configured", "verified-thread"]);
      yield* step();
      yield* step();
      assert.strictEqual((yield* r.listAttempts(job.jobId)).length, 3);
      assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).state, "exhausted");
    }),
  );

  it.effect("deduplicates a genuinely attempted complete auxiliary path", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const f = makeCoordinatorFixture(r);
      const context = capturedTitle();
      const job = yield* f.create({ ...context, threadPath: context.primaryPath });
      yield* f.coordinator.step(job.jobId);
      f.advance(2_000);
      yield* f.coordinator.step(job.jobId);
      f.advance(10_000);
      yield* f.coordinator.step(job.jobId);
      yield* f.coordinator.step(job.jobId);
      assert.strictEqual(f.control.calls.length, 2);
      assert.isFalse((yield* r.listAttempts(job.jobId)).some((a) => a.stage === "thread-model"));
    }),
  );

  it.effect("persists a result once and retries only canonical persistence", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const f = makeCoordinatorFixture(r);
      f.control.outcome = "success";
      f.control.commitFails = true;
      const job = yield* f.create();
      yield* f.coordinator.step(job.jobId);
      const retained = (yield* r.listAttempts(job.jobId))[0]!;
      assert.strictEqual(retained.state, "result-ready");
      for (let index = 0; index < 2; index += 1) {
        assert.strictEqual(
          (yield* f.coordinator.step(job.jobId).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.deepStrictEqual((yield* r.listAttempts(job.jobId))[0], retained);
      }
      f.advance(3_600_000);
      f.control.commitFails = false;
      yield* f.coordinator.step(job.jobId);
      assert.strictEqual(f.control.calls.length, 1);
      assert.deepStrictEqual(f.control.commits, Array(3).fill("Repair durable metadata recovery"));
      assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).state, "completed");
    }),
  );

  it.effect("uncertainty survives deadlines, invalidation and configuration unavailability", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const f = makeCoordinatorFixture(r);
      f.control.outcome = "uncertain";
      const job = yield* f.create();
      yield* f.coordinator.step(job.jobId);
      f.advance(86_400_000);
      f.control.current = false;
      f.control.settingsAvailable = false;
      yield* f.coordinator.step(job.jobId);
      yield* f.coordinator.step(job.jobId);
      assert.strictEqual((yield* r.listAttempts(job.jobId))[0]!.state, "uncertain");
      assert.strictEqual(f.control.calls.length, 1);
      assert.strictEqual(
        (yield* r.listPendingWarnings(10)).filter((w) => w.threadId === job.threadId).length,
        0,
      );
    }),
  );

  it.effect("a defect after dispatch leaves durable intent, never a fresh attempt", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const f = makeCoordinatorFixture(r);
      f.control.outcome = "defect";
      const job = yield* f.create();
      assert.strictEqual((yield* f.coordinator.step(job.jobId).pipe(Effect.exit))._tag, "Failure");
      assert.strictEqual((yield* r.listAttempts(job.jobId))[0]!.state, "dispatch-intent");
      f.control.outcome = "failed";
      yield* f.coordinator.step(job.jobId);
      assert.strictEqual(f.control.calls.length, 1);
    }),
  );

  it.effect("a lost durable claim response cannot authorize replay or settle another owner", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const lost = {
        ...r,
        claimDispatch: (a: Parameters<typeof r.claimDispatch>[0], at: string) =>
          r
            .claimDispatch(a, at)
            .pipe(
              Effect.andThen(
                Effect.fail(
                  new PersistenceSqlError({ operation: "claimDispatch", detail: "Lost response" }),
                ),
              ),
            ),
      };
      const f = makeCoordinatorFixture(lost);
      const job = yield* f.create();
      yield* f.coordinator.step(job.jobId);
      assert.strictEqual((yield* r.listAttempts(job.jobId))[0]!.state, "dispatch-intent");
      yield* f.coordinator.step(job.jobId);
      assert.strictEqual(f.control.calls.length, 0);
    }),
  );

  it.effect("competing workers submit at most one generation", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const f = makeCoordinatorFixture(r);
      const job = yield* f.create();
      yield* Effect.all([f.coordinator.step(job.jobId), f.coordinator.step(job.jobId)], {
        concurrency: 2,
      });
      assert.strictEqual(f.control.calls.length, 1);
      assert.strictEqual((yield* r.listAttempts(job.jobId)).length, 1);
      assert.strictEqual((yield* r.listAttempts(job.jobId))[0]!.state, "failed");
    }),
  );

  it.effect(
    "preflight unavailability is not a failure and does not suppress a thread-path attempt",
    () =>
      Effect.gen(function* () {
        const r = yield* ThreadMetadataGenerationRepository;
        const f = makeCoordinatorFixture(r);
        const context = capturedTitle();
        const job = yield* f.create({
          ...context,
          configEpoch: "preflight-unavailable",
          threadPath: context.primaryPath,
        });
        f.control.settingsAvailable = false;
        yield* f.coordinator.step(job.jobId);
        f.control.settingsAvailable = true;
        yield* f.coordinator.step(job.jobId);
        assert.strictEqual(f.control.calls.length, 1);
        assert.deepStrictEqual(
          (yield* r.listAttempts(job.jobId)).map((a) => [a.stage, a.state]),
          [
            ["primary", "unavailable"],
            ["thread-model", "failed"],
          ],
        );
        const warnings = (yield* r.listPendingWarnings(10)).filter(
          (w) => w.threadId === job.threadId,
        );
        assert.strictEqual(warnings.length, 1);
        assert.strictEqual(warnings[0]?.primaryFailures, 0);
      }),
  );

  it.effect("cancelled dispatches never advance into fallback", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const f = makeCoordinatorFixture(r);
      f.control.outcome = "cancelled";
      const job = yield* f.create();
      yield* f.coordinator.step(job.jobId);
      yield* f.coordinator.step(job.jobId);
      assert.strictEqual(f.control.calls.length, 1);
      assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).state, "cancelled");
    }),
  );

  it.effect("stale undispatched jobs and inconsistent captured contexts cannot generate", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const f = makeCoordinatorFixture(r);
      f.control.current = false;
      const job = yield* f.create();
      yield* f.coordinator.step(job.jobId);
      assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).state, "stale");
      const context = capturedTitle();
      const bad = yield* makeCoordinatorFixture(r).create({
        ...context,
        configEpoch: "other-epoch",
        primaryPath: { ...context.primaryPath!, executionTarget: "remote" },
      });
      assert.strictEqual(
        (yield* f.coordinator.step(bad.jobId).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(Option.getOrThrow(yield* r.get(bad.jobId)).state, "quarantined");
      assert.strictEqual(f.control.calls.length, 0);
    }),
  );
});

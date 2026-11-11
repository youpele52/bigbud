import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { seedThread } from "../../persistence/Layers/ThreadMetadataGeneration.legacy.test-helpers.ts";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { ThreadMetadataGenerationRepository } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import { makeMetadataCoordinator } from "./ThreadMetadataGeneration.coordinator.ts";
import {
  capturedTitle,
  coordinatorTestLayer,
  makeCoordinatorFixture,
} from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";
import { loadMetadataContext } from "./ThreadMetadataGeneration.modelBinding.ts";

it.layer(coordinatorTestLayer)("bounded verified-model readiness", (it) => {
  it.effect(
    "binds a late verified fallback once and preserves its single-attempt budget after restart",
    () =>
      Effect.gen(function* () {
        const r = yield* ThreadMetadataGenerationRepository;
        const f = makeCoordinatorFixture(r);
        const captured = capturedTitle();
        const path = captured.threadPath!;
        const job = yield* f.create({
          ...captured,
          configuredPrimary: false,
          primaryPath: null,
          threadPath: null,
        });
        yield* seedThread(job.threadId);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_threads SET title = ${captured.initialTitle} WHERE thread_id = ${job.threadId}`;
        yield* f.coordinator.step(job.jobId);
        const waiting = Option.getOrThrow(yield* r.get(job.jobId));
        assert.strictEqual(waiting.state, "waiting-model");
        assert.strictEqual(Date.parse(waiting.nextAttemptAt) - Date.parse(f.control.at), 2_000);
        assert.strictEqual(f.control.calls.length, 0);
        f.advance(65_000);
        yield* r.recordSuccessfulModel(job.threadId, JSON.stringify(path.selection));
        f.control.verifiedPath = path;
        yield* f.coordinator.step(job.jobId);
        const bound = Option.getOrThrow(yield* r.get(job.jobId));
        assert.strictEqual(bound.contextJson, job.contextJson);
        assert.strictEqual(bound.revision, waiting.revision + 1);
        const originalBinding = Option.getOrThrow(yield* r.readThreadModelBinding(job.jobId));
        yield* r.recordSuccessfulModel(
          job.threadId,
          JSON.stringify({ provider: "codex", model: "newer" }),
        );
        f.control.verifiedPath = { ...path, selection: { provider: "codex", model: "newer" } };
        const context = yield* loadMetadataContext(r, bound);
        assert.isNull(context.primaryPath);
        assert.deepStrictEqual(context.threadPath, path);
        const step = () =>
          makeMetadataCoordinator({
            repository: r,
            host: f.host,
            textGeneration: f.textGeneration,
          }).step(job.jobId);
        yield* step();
        f.advance(2_000);
        yield* step();
        f.advance(10_000);
        yield* step();
        yield* step();
        yield* step();
        assert.deepStrictEqual(f.control.calls, ["verified-thread"]);
        assert.deepStrictEqual(
          Option.getOrThrow(yield* r.readThreadModelBinding(job.jobId)),
          originalBinding,
        );
        assert.deepStrictEqual(
          (yield* r.listAttempts(job.jobId)).map((a) => [a.stage, a.ordinal]),
          [["thread-model", 1]],
        );
        assert.deepStrictEqual(
          (yield* r.listPendingWarnings(100))
            .filter((w) => w.threadId === job.threadId)
            .map((w) => w.kind),
          ["final"],
        );
      }),
  );

  it.effect("waits for the exact fallback model after two confirmed configured failures", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const f = makeCoordinatorFixture(r);
      const captured = capturedTitle();
      const job = yield* f.create({ ...captured, threadPath: null });
      yield* f.coordinator.step(job.jobId);
      f.advance(2_000);
      yield* f.coordinator.step(job.jobId);
      f.advance(10_000);
      yield* f.coordinator.step(job.jobId);
      yield* f.coordinator.step(job.jobId);
      assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).state, "waiting-model");
      assert.strictEqual(
        (yield* r.listPendingWarnings(100)).filter((w) => w.threadId === job.threadId).length,
        1,
      );
      f.advance(65_000);
      f.control.verifiedPath = captured.threadPath;
      yield* r.recordSuccessfulModel(job.threadId, JSON.stringify(captured.threadPath!.selection));
      const resumed = makeMetadataCoordinator({
        repository: r,
        host: f.host,
        textGeneration: f.textGeneration,
      });
      yield* resumed.step(job.jobId);
      yield* resumed.step(job.jobId);
      assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).deadlineAt, job.deadlineAt);
      assert.deepStrictEqual(
        (yield* r.listAttempts(job.jobId)).map((a) => [a.stage, a.ordinal]),
        [
          ["primary", 1],
          ["primary", 2],
          ["thread-model", 1],
        ],
      );
      assert.deepStrictEqual(f.control.calls, ["configured", "configured", "verified-thread"]);
    }),
  );

  it.effect(
    "expires missing evidence without fabricating an override failure or accepting later evidence",
    () =>
      Effect.gen(function* () {
        const r = yield* ThreadMetadataGenerationRepository;
        const f = makeCoordinatorFixture(r);
        const captured = capturedTitle();
        const job = yield* f.create({
          ...captured,
          configuredPrimary: false,
          primaryPath: null,
          threadPath: null,
        });
        yield* f.coordinator.step(job.jobId);
        f.advance(1_800_000);
        yield* f.coordinator.step(job.jobId);
        assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).state, "exhausted");
        yield* r.recordSuccessfulModel(
          job.threadId,
          JSON.stringify(captured.threadPath!.selection),
        );
        f.control.verifiedPath = captured.threadPath;
        yield* f.coordinator.step(job.jobId);
        assert.strictEqual((yield* r.listAttempts(job.jobId)).length, 0);
        assert.strictEqual(f.control.calls.length, 0);
        assert.isTrue(Option.isNone(yield* r.readThreadModelBinding(job.jobId)));
        assert.strictEqual(
          (yield* r.listPendingWarnings(100)).filter((w) => w.threadId === job.threadId).length,
          0,
        );
      }),
  );

  it.effect("bounds a stalled path capture without starting generation", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const f = makeCoordinatorFixture(r);
      const captured = capturedTitle();
      const job = yield* f.create({
        ...captured,
        configuredPrimary: false,
        primaryPath: null,
        threadPath: null,
      });
      yield* r.recordSuccessfulModel(job.threadId, JSON.stringify(captured.threadPath!.selection));
      const started = yield* Deferred.make<void>();
      const coordinator = makeMetadataCoordinator({
        repository: r,
        textGeneration: f.textGeneration,
        host: {
          ...f.host,
          captureVerifiedThreadPath: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        },
      });
      const worker = yield* Effect.forkChild(coordinator.step(job.jobId));
      yield* Deferred.await(started);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(worker);
      assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).state, "waiting-model");
      assert.strictEqual(f.control.calls.length, 0);
      assert.isTrue(Option.isNone(yield* r.readThreadModelBinding(job.jobId)));
    }),
  );

  for (const fault of ["selection", "workspace"] as const) {
    it.effect(`refuses ${fault} substitution when capturing a verified model`, () =>
      Effect.gen(function* () {
        const r = yield* ThreadMetadataGenerationRepository;
        const f = makeCoordinatorFixture(r);
        const captured = capturedTitle();
        const path = captured.threadPath!;
        const job = yield* f.create({
          ...captured,
          configuredPrimary: false,
          primaryPath: null,
          threadPath: null,
        });
        yield* r.recordSuccessfulModel(job.threadId, JSON.stringify(path.selection));
        f.control.verifiedPath =
          fault === "selection"
            ? { ...path, selection: { provider: "codex", model: "substituted" } }
            : { ...path, executionTarget: "remote:other" };
        assert.strictEqual(
          (yield* f.coordinator.step(job.jobId).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.isTrue(Option.isNone(yield* r.readThreadModelBinding(job.jobId)));
        assert.strictEqual(f.control.calls.length, 0);
      }),
    );
  }

  it.effect("does not quarantine a valid job when a binding read fails", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const f = makeCoordinatorFixture(r);
      const job = yield* f.create();
      const coordinator = makeMetadataCoordinator({
        host: f.host,
        textGeneration: f.textGeneration,
        repository: {
          ...r,
          readThreadModelBinding: () =>
            Effect.fail(
              new PersistenceSqlError({ operation: "readBinding", detail: "Unavailable SQL" }),
            ),
        },
      });
      assert.strictEqual((yield* coordinator.step(job.jobId).pipe(Effect.result))._tag, "Failure");
      assert.deepStrictEqual(Option.getOrThrow(yield* r.get(job.jobId)), job);
      assert.strictEqual(f.control.calls.length, 0);
    }),
  );
});

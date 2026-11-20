import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeThreadMetadataGenerationRepository } from "../../persistence/Layers/ThreadMetadataGeneration.ts";
import { ThreadMetadataGenerationRepository } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import { createRuntime, withDatabase } from "./OrchestrationEngine.test.runtime.ts";
import { makeMetadataCoordinator } from "./ThreadMetadataGeneration.coordinator.ts";
import {
  capturedTitle,
  coordinatorTestLayer,
  makeCoordinatorFixture,
} from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";

it("retains warning counts and acknowledged epoch dedup across reopened persistence and operations", () =>
  withDatabase("bigbud-warning-restart-", async (dbPath) => {
    let runtime = createRuntime(dbPath);
    try {
      const original = await runtime.runPromise(
        Effect.gen(function* () {
          const repository = yield* makeThreadMetadataGenerationRepository();
          const f = makeCoordinatorFixture(repository);
          const job = yield* f.create({
            ...capturedTitle(),
            configEpoch: "durable-unavailable",
            primaryPath: null,
            threadPath: null,
          });
          yield* f.coordinator.step(job.jobId);
          const [warning] = yield* repository.listPendingWarnings(100);
          assert.strictEqual(warning?.primaryFailures, 0);
          return { job, warning: warning! };
        }),
      );
      await runtime.dispose();
      runtime = createRuntime(dbPath);
      await runtime.runPromise(
        Effect.gen(function* () {
          const repository = yield* makeThreadMetadataGenerationRepository();
          const f = makeCoordinatorFixture(repository);
          yield* f.coordinator.step(original.job.jobId);
          assert.deepStrictEqual(yield* repository.listPendingWarnings(100), [original.warning]);
          const claimed = yield* repository.claimPendingWarnings({
            clientId: "reopened-renderer",
            at: f.control.at,
            until: new Date(Date.parse(f.control.at) + 30_000).toISOString(),
          });
          assert.deepStrictEqual(claimed, [original.warning]);
          assert.isTrue(
            yield* repository.acknowledgeWarning({
              warningId: original.warning.id,
              clientId: "reopened-renderer",
              at: f.control.at,
            }),
          );
          const captured = capturedTitle();
          const summary = yield* f.create({
            version: 1,
            operation: "summary",
            threadId: captured.threadId,
            expectedRevision: 0,
            configEpoch: original.job.configEpoch,
            configuredPrimary: true,
            primaryPath: null,
            threadPath: null,
            workspace: captured.workspace,
            source: captured.source,
            previousSummary: "Retained summary",
            previousMessageCount: 0,
            transcript: "User: repair metadata",
          });
          yield* f.coordinator.step(summary.jobId);
          assert.deepStrictEqual(yield* repository.listPendingWarnings(100), []);
          assert.strictEqual((yield* repository.listAttempts(original.job.jobId)).length, 0);
          assert.strictEqual((yield* repository.listAttempts(summary.jobId)).length, 0);
          assert.strictEqual(f.control.calls.length, 0);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  }));

it.layer(coordinatorTestLayer)("unavailable configured metadata warnings", (it) => {
  for (const mode of ["missing-path", "preflight"] as const) {
    it.effect(`durably delivers and deduplicates ${mode} without inventing paid failures`, () =>
      Effect.gen(function* () {
        const repository = yield* ThreadMetadataGenerationRepository;
        const f = makeCoordinatorFixture(repository);
        const captured = capturedTitle();
        const job = yield* f.create({
          ...captured,
          configEpoch: `warning-${mode}`,
          primaryPath: mode === "missing-path" ? null : captured.primaryPath,
          threadPath: null,
        });
        f.control.outcome = "unavailable";
        yield* f.coordinator.step(job.jobId);
        yield* f.coordinator.step(job.jobId);
        assert.strictEqual(f.control.calls.length, 0);
        const warnings = (yield* repository.listPendingWarnings(100)).filter(
          (warning) => warning.threadId === job.threadId,
        );
        assert.strictEqual(warnings.length, 1);
        const warning = warnings[0]!;
        assert.strictEqual(warning.primaryFailures, 0);
        assert.strictEqual(
          (yield* repository.listAttempts(job.jobId)).filter((a) => a.state === "failed").length,
          0,
        );
        assert.isFalse(
          yield* repository.enqueueWarning({
            jobId: job.jobId,
            warningId: "duplicate-warning",
            at: f.control.at,
          }),
        );
        const until = new Date(Date.parse(f.control.at) + 30_000).toISOString();
        const claimed = yield* repository.claimPendingWarnings({
          clientId: "renderer",
          at: f.control.at,
          until,
        });
        assert.deepStrictEqual(
          claimed.find((item) => item.id === warning.id),
          warning,
        );
        assert.isTrue(
          yield* repository.acknowledgeWarning({
            warningId: warning.id,
            clientId: "renderer",
            at: f.control.at,
          }),
        );
        assert.isFalse(
          (yield* repository.listPendingWarnings(100)).some((w) => w.id === warning.id),
        );
        assert.strictEqual(
          Option.getOrThrow(yield* repository.get(job.jobId)).deadlineAt,
          job.deadlineAt,
        );
      }),
    );
  }

  for (const failures of [1, 2]) {
    it.effect(`retains ${failures} actual failures when the next primary is unavailable`, () =>
      Effect.gen(function* () {
        const repository = yield* ThreadMetadataGenerationRepository;
        const f = makeCoordinatorFixture(repository);
        const job = yield* f.create({
          ...capturedTitle(),
          configEpoch: `warning-after-${failures}-failures`,
          threadPath: null,
        });
        for (let index = 0; index < failures; index++) {
          yield* f.coordinator.step(job.jobId);
          f.advance(10_000);
        }
        f.control.outcome = "unavailable";
        yield* f.coordinator.step(job.jobId);
        const resumed = makeMetadataCoordinator({
          repository,
          host: f.host,
          textGeneration: f.textGeneration,
        });
        yield* resumed.step(job.jobId);
        yield* resumed.step(job.jobId);
        const warnings = (yield* repository.listPendingWarnings(100)).filter(
          (w) => w.threadId === job.threadId,
        );
        assert.strictEqual(warnings.length, 1);
        assert.strictEqual(warnings[0]?.primaryFailures, failures);
        assert.strictEqual(f.control.calls.length, failures);
        assert.deepStrictEqual(
          (yield* repository.listAttempts(job.jobId)).map((a) => a.state),
          [...Array(failures).fill("failed"), ...(failures < 2 ? ["unavailable"] : [])],
        );
      }),
    );
  }

  it.effect("warns and immediately uses an already verified fallback with no primary path", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadMetadataGenerationRepository;
      const f = makeCoordinatorFixture(repository);
      f.control.outcome = "success";
      const job = yield* f.create({
        ...capturedTitle(),
        configEpoch: "missing-primary-ready-fallback",
        primaryPath: null,
      });
      yield* f.coordinator.step(job.jobId);
      yield* f.coordinator.step(job.jobId);
      assert.deepStrictEqual(f.control.calls, ["verified-thread"]);
      assert.deepStrictEqual(
        (yield* repository.listAttempts(job.jobId)).map((a) => [a.stage, a.state]),
        [["thread-model", "completed"]],
      );
      const warnings = (yield* repository.listPendingWarnings(100)).filter(
        (w) => w.threadId === job.threadId,
      );
      assert.strictEqual(warnings.length, 1);
      assert.strictEqual(warnings[0]?.primaryFailures, 0);
      assert.strictEqual(
        Option.getOrThrow(yield* repository.get(job.jobId)).deadlineAt,
        job.deadlineAt,
      );
    }),
  );
});

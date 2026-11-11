import { randomUUID } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { seedThread } from "../../persistence/Layers/ThreadMetadataGeneration.legacy.test-helpers.ts";
import { ThreadMetadataGenerationRepository } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import type { MetadataCapturedContext } from "./ThreadMetadataGeneration.context.ts";
import {
  capturedTitle,
  coordinatorTestLayer,
  makeCoordinatorFixture,
} from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";

function captured(operation: "title" | "summary"): MetadataCapturedContext {
  // Settings warnings deduplicate globally by epoch, even across threads in this shared layer.
  const title = { ...capturedTitle(), configEpoch: randomUUID() };
  return operation === "title"
    ? { ...title, initialTitle: "Legacy" }
    : {
        version: title.version,
        threadId: title.threadId,
        operation,
        expectedRevision: title.expectedRevision,
        configEpoch: title.configEpoch,
        configuredPrimary: title.configuredPrimary,
        primaryPath: title.primaryPath,
        threadPath: title.threadPath,
        workspace: title.workspace,
        source: title.source,
        previousSummary: null,
        previousMessageCount: 0,
        transcript: "user: Repair durable metadata recovery",
      };
}

it.layer(coordinatorTestLayer)("definitive unavailable metadata notices", (it) => {
  for (const operation of ["title", "summary"] as const) {
    for (const configuredPrimary of [false, true]) {
      it.effect(
        `${operation}: missing proof waits for the original deadline (configured=${configuredPrimary})`,
        () =>
          Effect.gen(function* () {
            const r = yield* ThreadMetadataGenerationRepository;
            const f = makeCoordinatorFixture(r);
            const job = yield* f.create({
              ...captured(operation),
              configuredPrimary,
              primaryPath: null,
              threadPath: null,
            });
            yield* seedThread(job.threadId);
            yield* f.coordinator.step(job.jobId);
            assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).state, "waiting-model");
            f.advance(Date.parse(job.deadlineAt) - Date.parse(f.control.at) - 1);
            yield* f.coordinator.step(job.jobId);
            assert.isFalse(
              (yield* r.listPendingWarnings(100)).some(
                (w) => w.threadId === job.threadId && w.kind === "final",
              ),
            );
            f.advance(1);
            yield* f.coordinator.step(job.jobId);
            yield* f.coordinator.step(job.jobId);
            assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).state, "exhausted");
            assert.deepStrictEqual(f.control.calls, []);
            assert.deepStrictEqual(yield* r.listAttempts(job.jobId), []);
            const warnings = (yield* r.listPendingWarnings(100)).filter(
              (w) => w.threadId === job.threadId,
            );
            for (const warning of warnings) {
              assert.isTrue(
                yield* r.claimWarning({
                  warningId: warning.id,
                  clientId: "renderer",
                  at: f.control.at,
                  until: new Date(Date.parse(f.control.at) + 30_000).toISOString(),
                }),
              );
            }
            assert.deepStrictEqual(
              warnings.map((w) => w.kind).toSorted(),
              configuredPrimary ? ["final", "settings"] : ["final"],
            );
            assert.strictEqual(warnings.find((w) => w.kind === "final")?.operation, operation);
            assert.isTrue(warnings.every((w) => w.primaryFailures === 0));
          }),
      );

      for (const reason of ["settings", "preflight"] as const) {
        it.effect(
          `${operation}: unusable ${reason} settles without paid calls (configured=${configuredPrimary})`,
          () =>
            Effect.gen(function* () {
              const r = yield* ThreadMetadataGenerationRepository;
              const f = makeCoordinatorFixture(r);
              const context = captured(operation);
              const job = yield* f.create({
                ...context,
                configuredPrimary,
                primaryPath: configuredPrimary ? context.primaryPath : null,
              });
              yield* seedThread(job.threadId);
              if (reason === "settings") f.control.settingsAvailable = false;
              else f.control.outcome = "unavailable";
              yield* f.coordinator.step(job.jobId);
              yield* f.coordinator.step(job.jobId);
              yield* f.coordinator.step(job.jobId);
              assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).state, "exhausted");
              assert.deepStrictEqual(f.control.calls, []);
              assert.deepStrictEqual(
                (yield* r.listAttempts(job.jobId)).map((a) => [a.stage, a.state]),
                configuredPrimary
                  ? [
                      ["primary", "unavailable"],
                      ["thread-model", "unavailable"],
                    ]
                  : [["thread-model", "unavailable"]],
              );
              const warnings = (yield* r.listPendingWarnings(100)).filter(
                (w) => w.threadId === job.threadId,
              );
              assert.deepStrictEqual(
                warnings.map((w) => w.kind).toSorted(),
                configuredPrimary ? ["final", "settings"] : ["final"],
              );
              assert.strictEqual(warnings.find((w) => w.kind === "final")?.operation, operation);
              assert.isTrue(warnings.every((w) => w.primaryFailures === 0));
            }),
        );
      }
    }

    it.effect(
      `${operation}: duplicate failed target gives a final notice with only two calls`,
      () =>
        Effect.gen(function* () {
          const r = yield* ThreadMetadataGenerationRepository;
          const f = makeCoordinatorFixture(r);
          const context = captured(operation);
          const job = yield* f.create({ ...context, threadPath: context.primaryPath });
          yield* seedThread(job.threadId);
          yield* f.coordinator.step(job.jobId);
          f.advance(2_000);
          yield* f.coordinator.step(job.jobId);
          yield* f.coordinator.step(job.jobId);
          yield* f.coordinator.step(job.jobId);
          assert.deepStrictEqual(f.control.calls, ["configured", "configured"]);
          assert.deepStrictEqual(
            (yield* r.listAttempts(job.jobId)).map((a) => [a.stage, a.state]),
            [
              ["primary", "failed"],
              ["primary", "failed"],
            ],
          );
          const warnings = (yield* r.listPendingWarnings(100)).filter(
            (w) => w.threadId === job.threadId,
          );
          assert.deepStrictEqual(warnings.map((w) => w.kind).toSorted(), ["final", "settings"]);
          assert.isTrue(warnings.every((w) => w.primaryFailures === 2));
        }),
    );
  }
});

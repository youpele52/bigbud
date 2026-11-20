import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { seedThread } from "../../persistence/Layers/ThreadMetadataGeneration.legacy.test-helpers.ts";
import { seedFinalAttempt } from "../../persistence/Layers/ThreadMetadataGeneration.finalWarnings.test-helpers.ts";
import { ThreadMetadataGenerationRepository } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import { makeMetadataCoordinator } from "./ThreadMetadataGeneration.coordinator.ts";
import {
  capturedTitle,
  coordinatorTestLayer,
  makeCoordinatorFixture,
} from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";

it.layer(coordinatorTestLayer)(
  "coordinator final-warning delivery and historical retirement",
  (it) => {
    it.effect(
      "two configured failures then one verified failure produce durable deliverable warnings",
      () =>
        Effect.gen(function* () {
          const r = yield* ThreadMetadataGenerationRepository;
          const f = makeCoordinatorFixture(r);
          const job = yield* f.create({ ...capturedTitle(), initialTitle: "Legacy" });
          yield* seedThread(job.threadId);
          const step = () =>
            makeMetadataCoordinator({
              repository: r,
              textGeneration: f.textGeneration,
              host: f.host,
            }).step(job.jobId);
          yield* step();
          assert.deepStrictEqual(yield* r.listPendingWarnings(100), []);
          f.advance(2_000);
          yield* step();
          yield* step();
          const settings = (yield* r.listPendingWarnings(100)).filter(
            (w) => w.threadId === job.threadId,
          );
          assert.deepStrictEqual(
            settings.map((w) => w.kind),
            ["settings"],
          );
          assert.strictEqual(settings[0]?.primaryFailures, 2);
          yield* step();
          yield* step();
          assert.deepStrictEqual(f.control.calls, ["configured", "configured", "verified-thread"]);
          assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).state, "exhausted");
          const warnings = (yield* r.claimPendingWarnings({
            clientId: "renderer",
            at: f.control.at,
            until: new Date(Date.parse(f.control.at) + 30_000).toISOString(),
          })).filter((w) => w.threadId === job.threadId);
          assert.deepStrictEqual(warnings.map((w) => w.kind).toSorted(), ["final", "settings"]);
          assert.strictEqual(warnings.find((w) => w.kind === "final")?.operation, "title");
        }),
    );

    it.effect(
      "deduplicating the failed configured target delivers a final warning without more inference",
      () =>
        Effect.gen(function* () {
          const r = yield* ThreadMetadataGenerationRepository;
          const f = makeCoordinatorFixture(r);
          const context = capturedTitle();
          const job = yield* f.create({
            ...context,
            initialTitle: "Legacy",
            configEpoch: "duplicate-final-warning",
            threadPath: context.primaryPath,
          });
          yield* seedThread(job.threadId);
          yield* f.coordinator.step(job.jobId);
          f.advance(2_000);
          yield* f.coordinator.step(job.jobId);
          yield* f.coordinator.step(job.jobId);
          yield* f.coordinator.step(job.jobId);
          assert.deepStrictEqual(f.control.calls, ["configured", "configured"]);
          assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).state, "exhausted");
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

    for (const operation of ["title", "summary"] as const) {
      it.effect(
        `${operation} prepared at deadline cancels without dispatch and queues final notice`,
        () =>
          Effect.gen(function* () {
            const r = yield* ThreadMetadataGenerationRepository;
            const f = makeCoordinatorFixture(r);
            const title = { ...capturedTitle(), initialTitle: "Legacy" };
            const context =
              operation === "title"
                ? title
                : {
                    version: title.version,
                    threadId: title.threadId,
                    expectedRevision: title.expectedRevision,
                    configEpoch: title.configEpoch,
                    configuredPrimary: title.configuredPrimary,
                    primaryPath: title.primaryPath,
                    threadPath: title.threadPath,
                    workspace: title.workspace,
                    source: title.source,
                    operation,
                    previousSummary: null,
                    previousMessageCount: 0,
                    transcript: "Repair durable metadata recovery",
                  };
            const job = yield* f.create(context);
            yield* seedThread(job.threadId);
            yield* seedFinalAttempt(job.jobId, "prepared");
            f.control.at = job.deadlineAt;
            yield* f.coordinator.step(job.jobId);
            yield* f.coordinator.step(job.jobId);
            assert.strictEqual(Option.getOrThrow(yield* r.get(job.jobId)).state, "exhausted");
            assert.strictEqual((yield* r.listAttempts(job.jobId))[0]?.state, "cancelled");
            assert.deepStrictEqual(f.control.calls, []);
            assert.deepStrictEqual(f.control.commits, []);
            const warnings = (yield* r.claimPendingWarnings({
              clientId: "deadline-renderer",
              at: f.control.at,
              until: new Date(Date.parse(f.control.at) + 30_000).toISOString(),
            })).filter((w) => w.threadId === job.threadId);
            assert.strictEqual(warnings.length, 1);
            assert.strictEqual(warnings[0]?.kind, "final");
            assert.strictEqual(warnings[0]?.operation, operation);
            assert.strictEqual(warnings[0]?.primaryFailures, 0);
          }),
      );
    }

    for (const state of [
      "prepared",
      "dispatch-intent",
      "acknowledged",
      "uncertain",
      "result-ready",
      "completed",
      "failed",
      "cancelled",
    ] as const) {
      it.effect(
        `historical native ${state} evidence cannot execute, commit, or produce a final warning`,
        () =>
          Effect.gen(function* () {
            const r = yield* ThreadMetadataGenerationRepository;
            const f = makeCoordinatorFixture(r);
            const job = yield* f.create();
            yield* seedFinalAttempt(job.jobId, state, "native");
            const before = (yield* r.listAttempts(job.jobId))[0]!;
            yield* f.coordinator.step(job.jobId);
            yield* f.coordinator.step(job.jobId);
            const after = (yield* r.listAttempts(job.jobId))[0]!;
            if (state === "prepared") {
              assert.strictEqual(after.state, "cancelled");
              assert.strictEqual(after.attemptId, before.attemptId);
              assert.strictEqual(after.payloadJson, before.payloadJson);
            } else assert.deepStrictEqual(after, before);
            assert.deepStrictEqual(f.control.calls, []);
            assert.deepStrictEqual(f.control.commits, []);
            assert.isFalse(
              (yield* r.listPendingWarnings(100)).some((w) => w.threadId === job.threadId),
            );
            assert.strictEqual(
              Option.getOrThrow(yield* r.get(job.jobId)).state,
              ["dispatch-intent", "acknowledged", "uncertain", "result-ready"].includes(state)
                ? "uncertain"
                : "quarantined",
            );
          }),
      );
    }
  },
);

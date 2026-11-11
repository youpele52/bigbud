import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadMetadataGenerationRepository } from "./ThreadMetadataGeneration.ts";
import { ThreadMetadataGenerationRepository } from "../Services/ThreadMetadataGeneration.ts";
import {
  createRuntime,
  withDatabase,
} from "../../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import {
  at,
  until,
  finalWarningLayer,
  seedFinalJob,
  seedFinalAttempt,
  exhaustFinalJob,
} from "./ThreadMetadataGeneration.finalWarnings.test-helpers.ts";

it.layer(finalWarningLayer)("definitive metadata final warnings", (it) => {
  for (const operation of ["title", "summary"] as const) {
    it.effect(
      `${operation} exhaustion atomically queues one warning without another scheduler step`,
      () =>
        Effect.gen(function* () {
          const { r, job } = yield* seedFinalJob(`final-${operation}`, operation);
          yield* seedFinalAttempt(job.jobId);
          assert.isTrue(yield* exhaustFinalJob(job.jobId));
          const warning = (yield* r.listPendingWarnings(100)).find(
            (w) => w.threadId === job.threadId,
          )!;
          assert.strictEqual(warning.kind, "final");
          assert.strictEqual(warning.operation, operation);
          assert.strictEqual(warning.primaryFailures, 0);
          assert.isFalse(yield* r.enqueueFinalWarning({ jobId: job.jobId, at }));
          assert.isFalse(
            yield* r.transitionJob({
              jobId: job.jobId,
              expectedRevision: 0,
              state: "exhausted",
              nextAttemptAt: at,
            }),
          );
        }),
    );
  }

  for (const terminal of ["exhausted", "unavailable"] as const) {
    for (const state of [
      "prepared",
      "dispatch-intent",
      "acknowledged",
      "uncertain",
      "result-ready",
      "completed",
      "stale",
      "cancelled",
    ] as const) {
      it.effect(`never turns ${state} thread evidence into ${terminal} final warning`, () =>
        Effect.gen(function* () {
          const { r, job } = yield* seedFinalJob(`no-final-${terminal}-${state}`);
          yield* seedFinalAttempt(job.jobId, state);
          if (state === "cancelled") {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE thread_metadata_generation_attempts SET dispatched_at = ${at}, revision = 2
              WHERE job_id = ${job.jobId}`;
          }
          yield* exhaustFinalJob(job.jobId, terminal);
          const sql = yield* SqlClient.SqlClient;
          // Even malformed historical terminal rows must not bypass delivery eligibility.
          yield* sql`UPDATE thread_metadata_generation_jobs SET state = ${terminal} WHERE job_id = ${job.jobId}`;
          assert.isFalse(yield* r.enqueueFinalWarning({ jobId: job.jobId, at }));
          assert.isFalse(
            (yield* r.listPendingWarnings(100)).some((w) => w.threadId === job.threadId),
          );
        }),
      );
    }
  }
  for (const terminal of ["exhausted", "unavailable"] as const) {
    for (const operation of ["title", "summary"] as const) {
      for (const evidence of ["none", "primary", "thread-model", "native"] as const) {
        it.effect(`${terminal} ${operation} with ${evidence} keeps factual warning counts`, () =>
          Effect.gen(function* () {
            const { r, job } = yield* seedFinalJob(
              `${terminal}-${operation}-${evidence}`,
              operation,
            );
            if (evidence !== "none")
              yield* seedFinalAttempt(
                job.jobId,
                evidence === "primary" ? "failed" : "unavailable",
                evidence,
              );
            assert.isTrue(yield* exhaustFinalJob(job.jobId, terminal));
            const warnings = (yield* r.listPendingWarnings(100)).filter(
              (w) => w.threadId === job.threadId,
            );
            if (evidence === "native") assert.deepStrictEqual(warnings, []);
            else {
              assert.strictEqual(warnings.length, 1);
              assert.strictEqual(warnings[0]?.kind, "final");
              assert.strictEqual(warnings[0]?.primaryFailures, evidence === "primary" ? 1 : 0);
            }
          }),
        );
      }
    }
  }

  for (const stage of ["primary", "native"] as const) {
    it.effect(
      `retained ${stage} dispatch evidence blocks a final warning despite a failed thread attempt`,
      () =>
        Effect.gen(function* () {
          const { r, job } = yield* seedFinalJob(`blocked-final-${stage}`);
          yield* seedFinalAttempt(job.jobId);
          yield* seedFinalAttempt(job.jobId, "uncertain", stage);
          assert.isFalse(yield* exhaustFinalJob(job.jobId));
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE thread_metadata_generation_jobs SET state = 'exhausted' WHERE job_id = ${job.jobId}`;
          assert.isFalse(yield* r.enqueueFinalWarning({ jobId: job.jobId, at }));
        }),
    );
  }

  for (const terminal of ["exhausted", "unavailable"] as const) {
    it.effect(
      `warning insertion failure rolls back ${terminal} and retry retains one delivery intent`,
      () =>
        Effect.gen(function* () {
          const { r, job } = yield* seedFinalJob(`atomic-final-${terminal}`);
          yield* seedFinalAttempt(job.jobId, terminal === "unavailable" ? "unavailable" : "failed");
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TEMP TRIGGER fail_final_warning BEFORE INSERT ON thread_metadata_generation_warnings
      WHEN NEW.warning_id LIKE 'metadata-final-warning:%' BEGIN SELECT RAISE(ABORT, 'injected warning failure'); END`;
          try {
            assert.strictEqual(
              (yield* exhaustFinalJob(job.jobId, terminal).pipe(Effect.result))._tag,
              "Failure",
            );
            const retained = Option.getOrThrow(yield* r.get(job.jobId));
            assert.strictEqual(retained.state, "pending");
            assert.strictEqual(retained.revision, 0);
            assert.strictEqual(
              (yield* r.listAttempts(job.jobId))[0]?.state,
              terminal === "unavailable" ? "unavailable" : "failed",
            );
          } finally {
            yield* sql`DROP TRIGGER fail_final_warning`;
          }
          assert.isTrue(yield* exhaustFinalJob(job.jobId, terminal));
          assert.strictEqual(
            (yield* r.listPendingWarnings(100)).filter((w) => w.threadId === job.threadId).length,
            1,
          );
        }),
    );
  }
});

it("persists per-thread/operation dedup, claims and acknowledgments through a database reopen", () =>
  withDatabase("bigbud-final-warning-", async (dbPath) => {
    let runtime = createRuntime(dbPath);
    try {
      const original = await runtime.runPromise(
        Effect.gen(function* () {
          const r = yield* makeThreadMetadataGenerationRepository();
          return yield* Effect.gen(function* () {
            const { job } = yield* seedFinalJob("reopened-final");
            yield* seedFinalAttempt(job.jobId);
            yield* exhaustFinalJob(job.jobId);
            return { job, warning: (yield* r.listPendingWarnings(100))[0]! };
          }).pipe(Effect.provideService(ThreadMetadataGenerationRepository, r));
        }),
      );
      await runtime.dispose();
      runtime = createRuntime(dbPath);
      await runtime.runPromise(
        Effect.gen(function* () {
          const r = yield* makeThreadMetadataGenerationRepository();
          assert.deepStrictEqual(yield* r.listPendingWarnings(100), [original.warning]);
          const claim = { warningId: original.warning.id, clientId: "renderer", at, until };
          assert.isTrue(yield* r.claimWarning(claim));
          assert.isFalse(yield* r.claimWarning({ ...claim, clientId: "other" }));
          assert.isFalse(yield* r.acknowledgeWarning({ ...claim, clientId: "other" }));
          assert.isTrue(yield* r.acknowledgeWarning(claim));
          const replacement = yield* r.createOrGet({
            ...original.job,
            jobId: "new-final-config",
            generationKey: "retry",
            configEpoch: "new-config",
          });
          yield* seedFinalAttempt(replacement.jobId);
          yield* r.transitionJob({
            jobId: replacement.jobId,
            expectedRevision: 0,
            state: "exhausted",
            nextAttemptAt: at,
          });
          assert.deepStrictEqual(yield* r.listPendingWarnings(100), []);
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT COUNT(*) AS count FROM thread_metadata_generation_warnings`,
            [{ count: 1 }],
          );
        }),
      );
    } finally {
      await runtime.dispose();
    }
  }));

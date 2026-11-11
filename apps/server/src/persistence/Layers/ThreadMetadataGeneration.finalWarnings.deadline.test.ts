import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
} from "./ThreadMetadataGeneration.finalWarnings.test-helpers.ts";

it.layer(finalWarningLayer)("deadline cancellation provenance", (it) => {
  for (const operation of ["title", "summary"] as const) {
    for (const change of ["dispatch", "stale", "quarantined", "revision", "archived"] as const) {
      it.effect(`${operation} marked cancellation rechecks ${change} before list and claim`, () =>
        Effect.gen(function* () {
          const { r, job } = yield* seedFinalJob(
            `deadline-recheck-${operation}-${change}`,
            operation,
          );
          yield* seedFinalAttempt(job.jobId, "prepared");
          assert.isTrue(
            yield* r.settleAttempt({
              attempt: (yield* r.listAttempts(job.jobId))[0]!,
              state: "cancelled",
              at: until,
            }),
          );
          assert.isTrue(
            yield* r.transitionJob({
              jobId: job.jobId,
              expectedRevision: 0,
              state: "exhausted",
              nextAttemptAt: until,
            }),
          );
          const warning = (yield* r.listPendingWarnings(100)).find(
            (w) => w.threadId === job.threadId,
          )!;
          assert.isDefined(warning);
          const sql = yield* SqlClient.SqlClient;
          if (change === "dispatch")
            yield* sql`UPDATE thread_metadata_generation_attempts SET dispatched_at = ${at} WHERE job_id = ${job.jobId}`;
          else if (change === "stale" || change === "quarantined")
            yield* sql`UPDATE thread_metadata_generation_jobs SET state = ${change} WHERE job_id = ${job.jobId}`;
          else if (change === "revision") yield* r.advanceMetadataRevision(job.threadId, operation);
          else
            yield* sql`UPDATE projection_threads SET archived_at = ${until} WHERE thread_id = ${job.threadId}`;
          assert.isFalse(yield* r.enqueueFinalWarning({ jobId: job.jobId, at: until }));
          assert.isFalse((yield* r.listPendingWarnings(100)).some((w) => w.id === warning.id));
          const claim = {
            warningId: warning.id,
            clientId: "renderer",
            at,
            until: "2026-11-10T10:01:00.000Z",
          };
          assert.isFalse(yield* r.claimWarning(claim));
          assert.isFalse((yield* r.claimPendingWarnings(claim)).some((w) => w.id === warning.id));
        }),
      );
    }
  }
  for (const evidence of [
    "historical",
    "early",
    "dispatch-intent",
    "acknowledged",
    "uncertain",
    "result-ready",
    "revised-prepared",
    "native",
  ] as const) {
    it.effect(
      `${evidence} cancellation cannot establish never-dispatched deadline eligibility`,
      () =>
        Effect.gen(function* () {
          const { r, job } = yield* seedFinalJob(`deadline-negative-${evidence}`);
          const state = ["historical", "early", "revised-prepared", "native"].includes(evidence)
            ? "prepared"
            : (evidence as "dispatch-intent" | "acknowledged" | "uncertain" | "result-ready");
          yield* seedFinalAttempt(
            job.jobId,
            evidence === "historical" ? "cancelled" : state,
            evidence === "native" ? "native" : "thread-model",
          );
          const sql = yield* SqlClient.SqlClient;
          if (
            [
              "dispatch-intent",
              "acknowledged",
              "uncertain",
              "result-ready",
              "revised-prepared",
            ].includes(evidence)
          )
            yield* sql`UPDATE thread_metadata_generation_attempts SET revision = 1 WHERE job_id = ${job.jobId}`;
          const attempt = (yield* r.listAttempts(job.jobId))[0]!;
          if (evidence !== "historical")
            yield* r.settleAttempt({
              attempt,
              state: "cancelled",
              at: evidence === "early" ? at : until,
            });
          // Malformed legacy terminal jobs still cannot bypass enqueue/list/claim rechecks.
          yield* sql`UPDATE thread_metadata_generation_jobs SET state = 'exhausted' WHERE job_id = ${job.jobId}`;
          assert.isFalse(yield* r.enqueueFinalWarning({ jobId: job.jobId, at: until }));
          assert.deepStrictEqual(
            yield* sql`SELECT cancelled_before_dispatch_at_deadline AS marker
          FROM thread_metadata_generation_attempts WHERE job_id = ${job.jobId}`,
            [{ marker: 0 }],
          );
          assert.isFalse(
            (yield* r.listPendingWarnings(100)).some((w) => w.threadId === job.threadId),
          );
        }),
    );
  }
});

for (const operation of ["title", "summary"] as const) {
  it(`reloads ${operation} never-dispatched deadline evidence before settlement, list and claim`, () =>
    withDatabase(`bigbud-deadline-${operation}-`, async (dbPath) => {
      let runtime = createRuntime(dbPath);
      try {
        const job = await runtime.runPromise(
          Effect.gen(function* () {
            const r = yield* makeThreadMetadataGenerationRepository();
            return yield* Effect.gen(function* () {
              const { job } = yield* seedFinalJob(`reopened-deadline-${operation}`, operation);
              yield* seedFinalAttempt(job.jobId, "prepared");
              const attempt = (yield* r.listAttempts(job.jobId))[0]!;
              assert.isTrue(yield* r.settleAttempt({ attempt, state: "cancelled", at: until }));
              return job;
            }).pipe(Effect.provideService(ThreadMetadataGenerationRepository, r));
          }),
        );
        await runtime.dispose();
        runtime = createRuntime(dbPath);
        await runtime.runPromise(
          Effect.gen(function* () {
            const r = yield* makeThreadMetadataGenerationRepository();
            assert.strictEqual((yield* r.listAttempts(job.jobId))[0]?.state, "cancelled");
            assert.isTrue(
              yield* r.transitionJob({
                jobId: job.jobId,
                expectedRevision: 0,
                state: "exhausted",
                nextAttemptAt: until,
              }),
            );
          }),
        );
        await runtime.dispose();
        runtime = createRuntime(dbPath);
        await runtime.runPromise(
          Effect.gen(function* () {
            const r = yield* makeThreadMetadataGenerationRepository();
            const warnings = yield* r.listPendingWarnings(100);
            assert.strictEqual(warnings.length, 1);
            assert.strictEqual(warnings[0]?.operation, operation);
            assert.strictEqual(warnings[0]?.primaryFailures, 0);
            const claim = {
              warningId: warnings[0]!.id,
              clientId: "renderer",
              at: until,
              until: "2026-11-10T10:01:00.000Z",
            };
            assert.isTrue(yield* r.claimWarning(claim));
            assert.isFalse(yield* r.claimWarning({ ...claim, clientId: "other" }));
            assert.isTrue(yield* r.acknowledgeWarning(claim));
            assert.deepStrictEqual(yield* r.listPendingWarnings(100), []);
          }),
        );
      } finally {
        await runtime.dispose();
      }
    }));
}

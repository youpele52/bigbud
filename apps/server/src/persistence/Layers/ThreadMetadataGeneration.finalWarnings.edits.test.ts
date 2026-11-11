import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  at,
  until,
  finalWarningLayer,
  seedFinalJob,
  seedFinalAttempt,
  exhaustFinalJob,
} from "./ThreadMetadataGeneration.finalWarnings.test-helpers.ts";

it.layer(finalWarningLayer)("metadata final warning edit races", (it) => {
  for (const operation of ["title", "summary"] as const) {
    for (const terminal of ["exhausted", "unavailable"] as const) {
      for (const timing of ["before-enqueue", "before-claim"] as const) {
        for (const edit of ["revision", "text", "archived", "deleting", "deleted"] as const) {
          it.effect(
            `${terminal} ${operation} ${edit} ${timing} suppresses stale warning delivery`,
            () =>
              Effect.gen(function* () {
                const { r, job, threadId } = yield* seedFinalJob(
                  `${terminal}-${operation}-${edit}-${timing}`,
                  operation,
                );
                yield* seedFinalAttempt(job.jobId);
                if (timing === "before-claim")
                  assert.isTrue(yield* exhaustFinalJob(job.jobId, terminal));
                const sql = yield* SqlClient.SqlClient;
                if (edit === "revision") yield* r.advanceMetadataRevision(threadId, operation);
                else if (edit === "text") {
                  if (operation === "title")
                    yield* sql`UPDATE projection_threads SET title = 'User rename' WHERE thread_id = ${threadId}`;
                  else
                    yield* sql`UPDATE projection_threads SET elevator_summary = 'Existing real summary' WHERE thread_id = ${threadId}`;
                } else {
                  const column = sql(
                    edit === "archived"
                      ? "archived_at"
                      : edit === "deleting"
                        ? "deleting_at"
                        : "deleted_at",
                  );
                  yield* sql`UPDATE projection_threads SET ${column} = ${at} WHERE thread_id = ${threadId}`;
                }
                if (timing === "before-enqueue")
                  assert.isTrue(yield* exhaustFinalJob(job.jobId, terminal));
                assert.isFalse(
                  (yield* r.listPendingWarnings(100)).some((w) => w.threadId === threadId),
                );
                assert.isFalse(
                  yield* r.claimWarning({
                    warningId: `metadata-final-warning:${job.jobId}`,
                    clientId: "renderer",
                    at,
                    until,
                  }),
                );
                assert.isFalse(
                  (yield* r.claimPendingWarnings({ clientId: "renderer", at, until })).some(
                    (w) => w.threadId === threadId,
                  ),
                );
                if (operation === "summary" && edit === "text") {
                  assert.deepStrictEqual(
                    yield* sql`SELECT elevator_summary AS summary, elevator_summary_message_count AS frontier FROM projection_threads WHERE thread_id = ${threadId}`,
                    [{ summary: "Existing real summary", frontier: 0 }],
                  );
                }
              }),
          );
        }
      }
    }
  }
  for (const placeholder of [null, "", "Legacy"]) {
    it.effect(
      `summary placeholder ${JSON.stringify(placeholder)} at frontier zero remains eligible`,
      () =>
        Effect.gen(function* () {
          const { r, job, threadId } = yield* seedFinalJob(
            `placeholder-${JSON.stringify(placeholder)}`,
            "summary",
          );
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE projection_threads SET elevator_summary = ${placeholder} WHERE thread_id = ${threadId}`;
          yield* seedFinalAttempt(job.jobId);
          assert.isTrue(yield* exhaustFinalJob(job.jobId));
          assert.isTrue((yield* r.listPendingWarnings(100)).some((w) => w.threadId === threadId));
        }),
    );
  }

  it.effect(
    "a nonzero summary frontier suppresses a warning without changing existing summary",
    () =>
      Effect.gen(function* () {
        const { r, job, threadId } = yield* seedFinalJob("existing-frontier", "summary");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_threads SET elevator_summary = 'Legacy', elevator_summary_message_count = 10 WHERE thread_id = ${threadId}`;
        yield* seedFinalAttempt(job.jobId);
        yield* exhaustFinalJob(job.jobId);
        assert.isFalse((yield* r.listPendingWarnings(100)).some((w) => w.threadId === threadId));
        assert.deepStrictEqual(
          yield* sql`SELECT elevator_summary AS summary FROM projection_threads WHERE thread_id = ${threadId}`,
          [{ summary: "Legacy" }],
        );
      }),
  );
});

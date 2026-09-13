import { ThreadId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LearningJobRepository } from "../Services/LearningJobs.ts";
import { LearningJobRepositoryLive } from "./LearningJobs.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";

const layer = LearningJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const now = "2026-09-13T00:00:00.000Z";
const later = "2026-09-13T00:01:00.000Z";
const fixture = (id: string) => ({
  jobId: id,
  threadId: ThreadId.makeUnsafe(id),
  turnId: TurnId.makeUnsafe(id),
  provider: "codex" as const,
  model: "gpt-5",
  modelSelection: { provider: "codex" as const, model: "gpt-5" },
  state: "queued" as const,
  memoryUserMessageCount: 15,
  createdAt: now,
  updatedAt: now,
});

it.layer(layer)("LearningJobRepository recovery", (it) => {
  it.effect("claims once, persists retry timing and exhausts attempts across restart", () =>
    Effect.gen(function* () {
      const repository = yield* LearningJobRepository;
      const sql = yield* SqlClient.SqlClient;
      const job = fixture("retry");
      yield* insertProjectionThreadParent({ sql, threadId: job.threadId });
      yield* repository.createIfAbsent(job);
      assert.isTrue(yield* repository.hasPending({ threadId: job.threadId }));
      const claims = yield* Effect.all(
        [repository.claim({ jobId: job.jobId, now }), repository.claim({ jobId: job.jobId, now })],
        { concurrency: 2 },
      );
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(claims.find(Boolean)?.attemptCount, 1);
      yield* repository.setState({
        jobId: job.jobId,
        state: "queued",
        updatedAt: now,
        nextAttemptAt: later,
        outcome: "provider-failed",
      });
      assert.equal(yield* repository.claim({ jobId: job.jobId, now }), null);
      assert.equal((yield* repository.claim({ jobId: job.jobId, now: later }))?.attemptCount, 2);
      assert.isTrue(yield* repository.acquireLease({ jobId: job.jobId, threadId: job.threadId }));
      yield* sql`INSERT INTO thread_activity_leases VALUES ('browser-kept', ${job.threadId}, 'browser', ${now})`;
      assert.deepEqual(yield* repository.recoverInterrupted({ now: later }), [
        {
          jobId: "retry",
          threadId: job.threadId,
          turnId: job.turnId,
          memoryUserMessageCount: 15,
          attemptCount: 2,
        },
      ]);
      assert.deepEqual(yield* sql`SELECT lease_id FROM thread_activity_leases`, [
        { lease_id: "browser-kept" },
      ]);
      assert.equal((yield* repository.claim({ jobId: job.jobId, now: later }))?.attemptCount, 3);
      assert.deepEqual(yield* repository.recoverInterrupted({ now: later }), [
        {
          jobId: "retry",
          threadId: job.threadId,
          turnId: job.turnId,
          memoryUserMessageCount: 15,
          attemptCount: 3,
        },
      ]);
      assert.equal(yield* repository.claim({ jobId: job.jobId, now: later }), null);
      assert.isFalse(yield* repository.hasPending({ threadId: job.threadId }));
      assert.equal(
        yield* repository.getLatestMemoryUserMessageCount({ threadId: job.threadId }),
        null,
      );
      assert.deepEqual(
        yield* sql`SELECT state, attempt_count FROM learning_jobs WHERE job_id = 'retry'`,
        [{ state: "failed", attempt_count: 3 }],
      );
    }),
  );

  it.effect(
    "counts beyond the review window and excludes messages newer than the source turn",
    () =>
      Effect.gen(function* () {
        const repository = yield* LearningJobRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("messages");
        yield* insertProjectionThreadParent({ sql, threadId });
        for (let i = 0; i < 130; i++) {
          const time = new Date(Date.parse(now) + i * 1000).toISOString();
          yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`message-${i}`}, ${threadId}, ${i === 119 ? "source" : null}, 'user', ${"x".repeat(5000)}, 0, ${time}, ${time})`;
        }
        assert.equal(yield* repository.countFinalizedUserMessages({ threadId }), 130);
        const messages = yield* repository.getReviewMessages({
          threadId,
          turnId: TurnId.makeUnsafe("source"),
        });
        assert.equal(messages.length, 100);
        assert.equal(messages[0]?.id, "message-20");
        assert.equal(messages.at(-1)?.id, "message-119");
        assert.equal(messages[0]?.text.length, 4000);
        assert.deepEqual(
          yield* repository.getReviewMessages({ threadId, turnId: TurnId.makeUnsafe("absent") }),
          [],
        );
      }),
  );

  it.effect("retains the preceding user when one assistant turn exceeds the bounded window", () =>
    Effect.gen(function* () {
      const repository = yield* LearningJobRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("long-turn");
      yield* insertProjectionThreadParent({ sql, threadId });
      for (let i = 0; i < 105; i++) {
        const time = new Date(Date.parse(now) + i * 1000).toISOString();
        yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`long-${i}`}, ${threadId}, ${i === 0 ? null : "source"}, ${i === 0 ? "user" : "assistant"}, 'text', 0, ${time}, ${time})`;
      }
      const messages = yield* repository.getReviewMessages({
        threadId,
        turnId: TurnId.makeUnsafe("source"),
      });
      assert.equal(messages.length, 100);
      assert.equal(messages[0]?.role, "user");
      assert.equal(messages[0]?.id, "long-0");
      assert.equal(messages.at(-1)?.id, "long-104");
    }),
  );

  it.effect("retained cleanup leases block further work until explicitly released", () =>
    Effect.gen(function* () {
      const repository = yield* LearningJobRepository;
      const sql = yield* SqlClient.SqlClient;
      const job = fixture("cleanup-failed");
      yield* insertProjectionThreadParent({ sql, threadId: job.threadId });
      yield* repository.createIfAbsent({ ...job, state: "failed" });
      assert.isTrue(yield* repository.acquireLease({ jobId: job.jobId, threadId: job.threadId }));
      assert.isTrue(yield* repository.hasPending({ threadId: job.threadId }));
      assert.isFalse(
        yield* repository.acquireLease({ jobId: "next-review", threadId: job.threadId }),
      );
      yield* repository.releaseLease(job.jobId);
      assert.isFalse(yield* repository.hasPending({ threadId: job.threadId }));
      assert.isTrue(
        yield* repository.acquireLease({ jobId: "next-review", threadId: job.threadId }),
      );
      yield* repository.releaseLease("next-review");
    }),
  );

  it.effect("refuses deleted owners and leaves historical failures unchanged", () =>
    Effect.gen(function* () {
      const repository = yield* LearningJobRepository;
      const sql = yield* SqlClient.SqlClient;
      const job = fixture("deleted");
      yield* insertProjectionThreadParent({ sql, threadId: job.threadId });
      yield* repository.createIfAbsent({ ...job, state: "failed" });
      yield* repository.recoverInterrupted({ now });
      assert.equal(yield* repository.claim({ jobId: job.jobId, now }), null);
      yield* sql`UPDATE projection_threads SET deleted_at = ${now} WHERE thread_id = ${job.threadId}`;
      assert.isFalse(yield* repository.acquireLease({ jobId: job.jobId, threadId: job.threadId }));
      assert.isFalse(
        yield* repository.acquireLease({
          jobId: "missing",
          threadId: ThreadId.makeUnsafe("missing"),
        }),
      );
    }),
  );
});

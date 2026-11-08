import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  resetRetentionTestRows,
  seedActivityLease,
  seedRetentionTestThread,
  seedWorktreeLease,
} from "../../retention/threadRetention.test.helpers.ts";
import { ThreadRetentionRepository } from "../Services/ThreadRetentionRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "./ThreadRetentionRepository.ts";

const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const oldAt = "2026-01-01T00:00:00.000Z";
const cutoffAt = "2026-02-01T00:00:00.000Z";
// Lease expiry and task staleness are judged against SQLite's own clock.
const future = () => new Date(Date.now() + 60 * 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

/** Returns the thread ids each selection mode would delete now. */
const selectable = Effect.fn("selectableRetentionThreads")(function* () {
  const repository = yield* ThreadRetentionRepository;
  const page = (selectionMode: "legacy-subtree" | "per-thread") =>
    repository
      .selectNextPage({
        cutoffAt,
        limit: 100,
        selectionMode,
        ageCriterion: "last-conversation-activity",
      })
      .pipe(Effect.map((rows) => rows.map((row) => String(row.threadId)).toSorted()));
  return { legacy: yield* page("legacy-subtree"), perThread: yield* page("per-thread") };
});

layer("ThreadRetentionRepository running semantics", (it) => {
  it.effect("only real work holds an old thread back", () =>
    Effect.gen(function* () {
      yield* resetRetentionTestRows();
      const sql = yield* SqlClient.SqlClient;
      const threads = [
        "idle-bound",
        "active-turn",
        "active-turn-id",
        "live-terminal",
        "expired-terminal",
        "live-browser",
        "expired-computer-use",
        "learning-fence",
        "fresh-task",
        "stale-task",
      ];
      for (const threadId of threads) yield* seedRetentionTestThread(threadId, oldAt);

      // A bound but idle provider session: runtime row still `running`, provider lease kept.
      yield* sql`INSERT INTO provider_session_runtime
        (thread_id, provider_name, adapter_key, status, last_seen_at)
        VALUES ('idle-bound', 'codex', 'codex', 'running', ${oldAt})`;
      yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
        VALUES ('idle-bound', 'ready', ${oldAt})`;
      yield* seedWorktreeLease({
        leaseId: "provider:idle-bound",
        threadId: "idle-bound",
        kind: "provider",
        expiresAt: null,
      });
      yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
        VALUES ('active-turn', 'running', ${oldAt})`;
      yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
        VALUES ('active-turn-id', 'ready', 'turn-active', ${oldAt})`;
      yield* seedWorktreeLease({
        leaseId: "terminal:live",
        threadId: "live-terminal",
        kind: "terminal",
        expiresAt: future(),
        processId: process.pid,
      });
      yield* seedWorktreeLease({
        leaseId: "terminal:expired",
        threadId: "expired-terminal",
        kind: "terminal",
        expiresAt: past(),
      });
      yield* seedActivityLease({
        leaseId: "browser:live",
        threadId: "live-browser",
        kind: "browser",
        expiresAt: future(),
      });
      yield* seedActivityLease({
        leaseId: "computer-use:expired",
        threadId: "expired-computer-use",
        kind: "computer-use",
        expiresAt: past(),
      });
      yield* seedActivityLease({
        leaseId: "learning:job",
        threadId: "learning-fence",
        kind: "learning",
        expiresAt: null,
      });
      yield* sql`INSERT INTO projection_thread_tasks (task_id, thread_id, task_json, created_at, updated_at)
        VALUES ('task-fresh', 'fresh-task', '{"status":"inProgress"}', ${oldAt}, ${new Date().toISOString()}),
          ('task-stale', 'stale-task', '{"status":"inProgress"}', ${oldAt},
            ${new Date(Date.now() - 25 * 60 * 60_000).toISOString()})`;

      const eligible = ["expired-computer-use", "expired-terminal", "idle-bound", "stale-task"];
      assert.deepEqual(yield* selectable(), { legacy: eligible, perThread: eligible });

      const repository = yield* ThreadRetentionRepository;
      const preview = yield* repository.preview(cutoffAt, {
        selectionMode: "per-thread",
        ageCriterion: "last-conversation-activity",
      });
      assert.equal(preview.eligibleCount, eligible.length);
      assert.deepEqual(preview.exclusionCounts, [
        { reason: "active_task", count: 1 },
        { reason: "running", count: 5 },
      ]);
    }),
  );

  it.effect("organisation state has no effect on selection", () =>
    Effect.gen(function* () {
      yield* resetRetentionTestRows();
      const sql = yield* SqlClient.SqlClient;
      for (const state of ["present", "needs-you", "later", "done"]) {
        yield* seedRetentionTestThread(`organised-${state}`, oldAt);
        yield* sql`UPDATE projection_threads SET organization_state = ${state}
          WHERE thread_id = ${`organised-${state}`}`;
      }
      const expected = [
        "organised-done",
        "organised-later",
        "organised-needs-you",
        "organised-present",
      ];
      assert.deepEqual(yield* selectable(), { legacy: expected, perThread: expected });
    }),
  );
});

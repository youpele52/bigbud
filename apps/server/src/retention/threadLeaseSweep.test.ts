import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  holdThreadLease,
  releaseThreadLease,
  renewHeldThreadLeases,
  THREAD_LEASE_TTL_MS,
} from "./threadLeaseHeartbeat.ts";
import { LEARNING_LEASE_STALE_MS, sweepThreadLeases } from "./threadLeaseSweep.ts";
import {
  resetRetentionTestRows,
  seedActivityLease,
  seedRetentionTestThread,
  seedWorktreeLease,
} from "./threadRetention.test.helpers.ts";

const layer = it.layer(SqlitePersistenceMemory);
const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
const at = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
/** A PID that cannot exist, so `kill(pid, 0)` reports ESRCH. */
const DEAD_PID = 2 ** 22 + 12_345;

const leaseIds = Effect.fn("remainingLeaseIds")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ leaseId: string }>`
    SELECT lease_id AS "leaseId" FROM worktree_runtime_leases
    UNION ALL SELECT lease_id FROM thread_activity_leases ORDER BY 1
  `;
  return rows.map((row) => row.leaseId);
});

layer("thread lease sweep", (it) => {
  it.effect("removes only leases whose holder is gone", () =>
    Effect.gen(function* () {
      yield* resetRetentionTestRows();
      const sql = yield* SqlClient.SqlClient;
      yield* seedRetentionTestThread("thread", at(-90 * 86_400_000));
      yield* sql`INSERT INTO provider_session_runtime
        (thread_id, provider_name, adapter_key, status, last_seen_at)
        VALUES ('thread', 'codex', 'codex', 'stopped', ${at(0)})`;
      const worktree = [
        ["provider:orphan", "provider", null, undefined],
        ["terminal:expired", "terminal", at(-1), undefined],
        ["terminal:no-expiry", "terminal", null, undefined],
        ["shell:dead-pid", "shell", at(60_000), DEAD_PID],
        ["terminal:live-pid", "terminal", at(60_000), process.pid],
        ["terminal:held-expired", "terminal", at(-1), undefined],
      ] as const;
      for (const [leaseId, kind, expiresAt, processId] of worktree) {
        yield* seedWorktreeLease({
          leaseId,
          threadId: "thread",
          kind,
          expiresAt,
          ...(processId !== undefined ? { processId } : {}),
        });
      }
      yield* seedActivityLease({
        leaseId: "browser:expired",
        threadId: "thread",
        kind: "browser",
        expiresAt: at(-1),
      });
      yield* seedActivityLease({
        leaseId: "computer-use:live",
        threadId: "thread",
        kind: "computer-use",
        expiresAt: at(60_000),
      });
      yield* sql`INSERT INTO learning_jobs
        (job_id, thread_id, turn_id, provider, model, model_selection_json, state, created_at, updated_at)
        VALUES ('old', 'thread', 'turn-old', 'opencodeV2', 'm', '{}', 'failed',
            ${at(-LEARNING_LEASE_STALE_MS - 1)}, ${at(-LEARNING_LEASE_STALE_MS - 1)}),
          ('recent', 'thread', 'turn-recent', 'opencodeV2', 'm', '{}', 'failed', ${at(-1)}, ${at(-1)}),
          ('running', 'thread', 'turn-running', 'opencodeV2', 'm', '{}', 'reviewing',
            ${at(-LEARNING_LEASE_STALE_MS - 1)}, ${at(-LEARNING_LEASE_STALE_MS - 1)})`;
      for (const job of ["old", "recent", "running"]) {
        yield* seedActivityLease({
          leaseId: `learning:${job}`,
          threadId: "thread",
          kind: "learning",
          expiresAt: null,
        });
      }
      holdThreadLease("terminal:held-expired");

      const swept = yield* sweepThreadLeases(sql, { nowMs });
      releaseThreadLease("terminal:held-expired");

      assert.deepEqual(swept, { provider: 1, runtime: 3, activity: 1, learning: 1 });
      assert.deepEqual(yield* leaseIds(), [
        "computer-use:live",
        "learning:recent",
        "learning:running",
        "terminal:held-expired",
        "terminal:live-pid",
      ]);
    }),
  );

  it.effect("deletes at most its budget per tick and resumes on the next", () =>
    Effect.gen(function* () {
      yield* resetRetentionTestRows();
      const sql = yield* SqlClient.SqlClient;
      yield* seedRetentionTestThread("bulk", at(-1));
      for (let index = 0; index < 7; index += 1) {
        yield* seedWorktreeLease({
          leaseId: `terminal:bulk-${index}`,
          threadId: "bulk",
          kind: "terminal",
          expiresAt: at(-1),
        });
      }
      const first = yield* sweepThreadLeases(sql, { nowMs, limit: 5 });
      assert.equal(first.runtime, 5);
      assert.lengthOf(yield* leaseIds(), 2);
      const second = yield* sweepThreadLeases(sql, { nowMs, limit: 5 });
      assert.equal(second.runtime, 2);
      assert.lengthOf(yield* leaseIds(), 0);
    }),
  );

  it.effect("the heartbeat renews held leases and nothing else", () =>
    Effect.gen(function* () {
      yield* resetRetentionTestRows();
      const sql = yield* SqlClient.SqlClient;
      yield* seedRetentionTestThread("heartbeat", at(-1));
      yield* seedWorktreeLease({
        leaseId: "shell:held",
        threadId: "heartbeat",
        kind: "shell",
        expiresAt: at(-1),
      });
      yield* seedActivityLease({
        leaseId: "browser:held",
        threadId: "heartbeat",
        kind: "browser",
        expiresAt: at(-1),
      });
      yield* seedActivityLease({
        leaseId: "browser:other",
        threadId: "heartbeat",
        kind: "browser",
        expiresAt: at(-1),
      });
      holdThreadLease("shell:held");
      holdThreadLease("browser:held");
      const renewed = yield* renewHeldThreadLeases(sql, nowMs);
      releaseThreadLease("shell:held");
      releaseThreadLease("browser:held");

      assert.equal(renewed, 2);
      const rows = yield* sql<{ leaseId: string; expiresAt: string }>`
        SELECT lease_id AS "leaseId", expires_at AS "expiresAt" FROM worktree_runtime_leases
        UNION ALL SELECT lease_id, expires_at FROM thread_activity_leases ORDER BY 1
      `;
      assert.deepEqual(rows, [
        { leaseId: "browser:held", expiresAt: at(THREAD_LEASE_TTL_MS) },
        { leaseId: "browser:other", expiresAt: at(-1) },
        { leaseId: "shell:held", expiresAt: at(THREAD_LEASE_TTL_MS) },
      ]);
    }),
  );
});

import { ExecutionTargetId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderSessionRuntimeRepository } from "../Services/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepositoryLive } from "./ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";

const layer = ProviderSessionRuntimeRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const NOW = "2026-08-04T00:00:00.000Z";
const local = ExecutionTargetId.makeUnsafe("local");

function runtime(
  threadId: ThreadId,
  input?: {
    remote?: boolean;
    cwd?: string | null;
    lastSeenAt?: string;
    status?: "running" | "stopped";
  },
) {
  const target = input?.remote ? ExecutionTargetId.makeUnsafe("ssh:test") : local;
  return {
    threadId,
    providerName: "codex",
    adapterKey: "codex",
    providerRuntimeExecutionTargetId: target,
    workspaceExecutionTargetId: target,
    executionTargetId: target,
    runtimeMode: "full-access" as const,
    status: input?.status ?? ("running" as const),
    lastSeenAt: input?.lastSeenAt ?? NOW,
    resumeCursor: null,
    runtimePayload: input?.cwd === null ? null : { cwd: input?.cwd ?? process.cwd() },
  };
}

it.layer(layer)("provider retention runtime leases", (it) => {
  it.effect("rejects a tombstoned endpoint after permanent projection deletion", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("provider-tombstone-thread");
      yield* sql`
        INSERT INTO orchestration_deletion_markers (
          entity_kind, entity_id, deletion_sequence, deleted_at
        ) VALUES ('thread', ${threadId}, 1, ${NOW})
      `;
      assert.equal((yield* Effect.exit(repository.upsert(runtime(threadId))))._tag, "Failure");
      const leases = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM worktree_runtime_leases WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(leases, [{ count: 0 }]);
    }),
  );

  it.effect("keeps a lease durable until explicit provider settlement", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("provider-durable-lease-thread");
      yield* insertProjectionThreadParent({ sql, threadId });
      yield* repository.upsert(runtime(threadId));
      assert.deepEqual(
        yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM worktree_runtime_leases WHERE thread_id = ${threadId}`,
        [{ count: 1 }],
      );
      yield* repository.deleteByThreadId({ threadId });
      assert.deepEqual(
        yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM worktree_runtime_leases WHERE thread_id = ${threadId}`,
        [{ count: 0 }],
      );
    }),
  );

  it.effect("permits runtimes without capturable local workspace leases", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const missing = ThreadId.makeUnsafe("provider-missing-cwd-thread");
      yield* insertProjectionThreadParent({ sql, threadId: missing });
      yield* repository.upsert(runtime(missing, { cwd: null }));
      const remote = ThreadId.makeUnsafe("provider-remote-thread");
      yield* repository.upsert(runtime(remote, { remote: true, cwd: "/remote/workspace" }));
      const leases = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM worktree_runtime_leases WHERE thread_id = ${remote}
      `;
      assert.deepEqual(leases, [{ count: 0 }]);
    }),
  );

  it.effect("bounds hot reconciliation reads to active or recent runtimes", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      const oldStopped = ThreadId.makeUnsafe("provider-old-stopped");
      const recentStopped = ThreadId.makeUnsafe("provider-recent-stopped");
      const oldRunning = ThreadId.makeUnsafe("provider-old-running");
      yield* repository.upsert(
        runtime(oldStopped, { status: "stopped", lastSeenAt: "2025-01-01T00:00:00.000Z" }),
      );
      yield* repository.upsert(runtime(recentStopped, { status: "stopped", lastSeenAt: NOW }));
      yield* repository.upsert(
        runtime(oldRunning, { status: "running", lastSeenAt: "2025-01-01T00:00:00.000Z" }),
      );

      const rows = yield* repository.list({
        mode: "hot",
        recentSince: "2026-01-01T00:00:00.000Z",
        limit: 10,
      });

      const rowIds = new Set(rows.map((row) => row.threadId));
      assert.equal(rowIds.has(recentStopped), true);
      assert.equal(rowIds.has(oldRunning), false);
      assert.equal(rowIds.has(oldStopped), false);
    }),
  );

  it.effect("pages the safety audit with a stable last-seen cursor", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      const first = ThreadId.makeUnsafe("provider-audit-first");
      const second = ThreadId.makeUnsafe("provider-audit-second");
      const third = ThreadId.makeUnsafe("provider-audit-third");
      yield* repository.upsert(
        runtime(first, { status: "stopped", lastSeenAt: "2099-01-01T00:00:00.000Z" }),
      );
      yield* repository.upsert(
        runtime(second, { status: "stopped", lastSeenAt: "2099-01-02T00:00:00.000Z" }),
      );
      yield* repository.upsert(
        runtime(third, { status: "stopped", lastSeenAt: "2099-01-03T00:00:00.000Z" }),
      );

      const page = yield* repository.list({ mode: "audit", limit: 2 });
      const next = page.find((row) => row.threadId === second);
      assert.equal(page.length, 2);
      if (!next) return;
      const remainder = yield* repository.list({
        mode: "audit",
        cursor: { lastSeenAt: next.lastSeenAt, threadId: next.threadId },
        limit: 2,
      });
      assert.deepEqual(
        remainder.map((row) => row.threadId),
        [third],
      );
    }),
  );
});

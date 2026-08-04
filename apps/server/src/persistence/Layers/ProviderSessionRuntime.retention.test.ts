import { ExecutionTargetId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderSessionRuntimeRepository } from "../Services/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepositoryLive } from "./ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = ProviderSessionRuntimeRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const NOW = "2026-08-04T00:00:00.000Z";
const local = ExecutionTargetId.makeUnsafe("local");

function runtime(threadId: ThreadId, input?: { remote?: boolean; cwd?: string | null }) {
  const target = input?.remote ? ExecutionTargetId.makeUnsafe("ssh:test") : local;
  return {
    threadId,
    providerName: "codex",
    adapterKey: "codex",
    providerRuntimeExecutionTargetId: target,
    workspaceExecutionTargetId: target,
    executionTargetId: target,
    runtimeMode: "full-access" as const,
    status: "running" as const,
    lastSeenAt: NOW,
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
      yield* repository.upsert(runtime(threadId));
      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
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
      yield* repository.upsert(runtime(missing, { cwd: null }));
      const remote = ThreadId.makeUnsafe("provider-remote-thread");
      yield* repository.upsert(runtime(remote, { remote: true, cwd: "/remote/workspace" }));
      const leases = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM worktree_runtime_leases WHERE thread_id = ${remote}
      `;
      assert.deepEqual(leases, [{ count: 0 }]);
    }),
  );
});

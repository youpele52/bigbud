import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  resetRetentionTestRows,
  seedRetentionTestThread,
  seedWorktreeLease,
} from "../../retention/threadRetention.test.helpers.ts";
import { ProviderSessionRuntimeRepository } from "../Services/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepositoryLive } from "./ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProviderSessionRuntimeRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const oldAt = "2026-01-01T00:00:00.000Z";
const probeAt = "2026-03-01T00:00:00.000Z";
const afterProbeAt = "2026-03-01T00:00:05.000Z";

const seedRuntime = Effect.fn("seedReconcileRuntime")(function* (input: {
  readonly threadId: string;
  readonly status: string;
  readonly lastSeenAt?: string;
  readonly provider?: string;
  readonly target?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* seedRetentionTestThread(input.threadId, oldAt);
  yield* sql`INSERT INTO provider_session_runtime
    (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json,
      runtime_payload_json, provider_runtime_execution_target_id)
    VALUES (${input.threadId}, ${input.provider ?? "codex"}, ${input.provider ?? "codex"},
      ${input.status}, ${input.lastSeenAt ?? oldAt}, ${`{"threadId":"native-${input.threadId}"}`},
      '{"activeTurnId":"turn-1","cwd":"/retention/worktree"}', ${input.target ?? "local"})`;
  yield* seedWorktreeLease({
    leaseId: `provider:${input.threadId}`,
    threadId: input.threadId,
    kind: "provider",
    expiresAt: null,
  });
});

const readRuntime = Effect.fn("readReconcileRuntime")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    status: string;
    resumeCursorJson: string | null;
    activeTurnId: string | null;
    leaseCount: number;
  }>`
    SELECT status, resume_cursor_json AS "resumeCursorJson",
      json_extract(runtime_payload_json, '$.activeTurnId') AS "activeTurnId",
      (SELECT COUNT(*) FROM worktree_runtime_leases WHERE thread_id = ${threadId}) AS "leaseCount"
    FROM provider_session_runtime WHERE thread_id = ${threadId}
  `;
  return rows[0];
});

layer("ProviderSessionRuntime reconcile", (it) => {
  it.effect("marks stale running rows stopped, keeps the resume cursor and drops the lease", () =>
    Effect.gen(function* () {
      yield* resetRetentionTestRows();
      yield* seedRuntime({ threadId: "stale", status: "running" });
      yield* seedRuntime({ threadId: "starting", status: "starting" });
      yield* seedRuntime({ threadId: "live", status: "running" });
      yield* seedRuntime({ threadId: "fresh", status: "running", lastSeenAt: afterProbeAt });
      yield* seedRuntime({ threadId: "down", status: "running", provider: "claudeAgent" });
      yield* seedRuntime({ threadId: "remote", status: "running", target: "ssh:box" });
      const repository = yield* ProviderSessionRuntimeRepository;

      const stopped = yield* repository.reconcileStale!({
        liveThreadIds: ["live"],
        unavailableProviders: ["claudeAgent"],
        observedBefore: probeAt,
        reconciledAt: probeAt,
      });

      assert.equal(stopped, 2);
      for (const threadId of ["stale", "starting"]) {
        const row = yield* readRuntime(threadId);
        assert.equal(row?.status, "stopped");
        assert.equal(row?.resumeCursorJson, `{"threadId":"native-${threadId}"}`);
        assert.isNull(row?.activeTurnId);
        assert.equal(row?.leaseCount, 0);
      }
      // A live session, a row written after the probe began, a provider whose listing failed
      // and a remote runtime are all left exactly as they were.
      for (const threadId of ["live", "fresh", "down", "remote"]) {
        const row = yield* readRuntime(threadId);
        assert.equal(row?.status, "running");
        assert.equal(row?.activeTurnId, "turn-1");
        assert.equal(row?.leaseCount, 1);
      }
    }),
  );

  it.effect("limits a turn-end pass to the given threads", () =>
    Effect.gen(function* () {
      yield* resetRetentionTestRows();
      yield* seedRuntime({ threadId: "ended", status: "running" });
      yield* seedRuntime({ threadId: "other", status: "running" });
      const repository = yield* ProviderSessionRuntimeRepository;

      const stopped = yield* repository.reconcileStale!({
        liveThreadIds: [],
        unavailableProviders: [],
        observedBefore: probeAt,
        reconciledAt: probeAt,
        threadIds: ["ended"],
      });

      assert.equal(stopped, 1);
      assert.equal((yield* readRuntime("ended"))?.status, "stopped");
      assert.equal((yield* readRuntime("other"))?.status, "running");
    }),
  );

  it.effect("processes more stale rows than one batch", () =>
    Effect.gen(function* () {
      yield* resetRetentionTestRows();
      for (let index = 0; index < 105; index += 1) {
        yield* seedRuntime({
          threadId: `bulk-${String(index).padStart(3, "0")}`,
          status: "running",
        });
      }
      const repository = yield* ProviderSessionRuntimeRepository;
      const stopped = yield* repository.reconcileStale!({
        liveThreadIds: [],
        unavailableProviders: [],
        observedBefore: probeAt,
        reconciledAt: probeAt,
      });
      assert.equal(stopped, 105);
      const sql = yield* SqlClient.SqlClient;
      const remaining = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM provider_session_runtime WHERE status = 'running'
      `;
      assert.equal(remaining[0]?.count, 0);
    }),
  );
});

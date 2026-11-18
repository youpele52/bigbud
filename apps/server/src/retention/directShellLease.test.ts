import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { seedRetentionTestThread, seedWorktreeLease } from "./threadRetention.test.helpers";
import { sweepThreadLeases } from "./threadLeaseSweep";
import { reconcileWorktreeRuntimeLeases } from "./worktreeRuntimeLease";
import { directShellOwnerKey } from "../terminal/Layers/DirectShellLaunch.owner";

it.layer(SqlitePersistenceMemory)("direct owner worktree protection", (it) => {
  it.effect(
    "retains expired/dead-transport lease across startup and sweeping until owner is removed",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threadId = "direct-lease";
        const leaseId = `terminal:${threadId}:pane`;
        yield* seedRetentionTestThread(threadId, "2026-01-01T00:00:00Z");
        yield* seedWorktreeLease({
          leaseId,
          threadId,
          kind: "terminal",
          expiresAt: "2026-01-01T00:00:00Z",
          processId: 2 ** 22 + 12345,
        });
        const ownerKey = directShellOwnerKey(threadId, "pane");
        yield* sql`INSERT INTO direct_shell_launch_owners (owner_key,reservation_id,controller_id,state,owner_json) VALUES (${ownerKey},'reservation','controller','outcome-unknown','{}')`;
        yield* reconcileWorktreeRuntimeLeases(sql, "terminal");
        yield* sweepThreadLeases(sql);
        expect(
          (yield* sql`SELECT 1 FROM worktree_runtime_leases WHERE lease_id = ${leaseId}`).length,
        ).toBe(1);
        yield* sql`DELETE FROM direct_shell_launch_owners WHERE owner_key = ${ownerKey}`;
        yield* reconcileWorktreeRuntimeLeases(sql, "terminal");
        expect(
          (yield* sql`SELECT 1 FROM worktree_runtime_leases WHERE lease_id = ${leaseId}`).length,
        ).toBe(0);
      }),
  );
});

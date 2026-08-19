import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { insertProjectionThreadParent } from "../persistence/Layers/ProjectionThread.test.helpers.ts";
import {
  captureWorktreePathIdentity,
  reconcileWorktreeRuntimeLeases,
} from "./worktreeRuntimeLease.ts";

it.layer(SqlitePersistenceMemory)("worktree runtime lease startup reconciliation", (it) => {
  it.effect("captures canonical identity through a symlink", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        nodeFs.mkdtemp("/tmp/bigbud-worktree-identity-"),
      );
      const alias = `${directory}-alias`;
      yield* Effect.promise(() => nodeFs.symlink(directory, alias));
      const identity = yield* Effect.promise(() => captureWorktreePathIdentity(alias));
      assert.equal(identity.canonicalPath, yield* Effect.promise(() => nodeFs.realpath(directory)));
      assert.deepEqual(
        [identity.device, identity.inode],
        [
          (yield* Effect.promise(() => nodeFs.lstat(directory))).dev,
          (yield* Effect.promise(() => nodeFs.lstat(directory))).ino,
        ],
      );
      yield* Effect.promise(() => nodeFs.rm(alias));
      yield* Effect.promise(() => nodeFs.rm(directory, { recursive: true }));
    }),
  );

  it.effect(
    "retains live and unconfirmed leases while removing confirmed terminated processes",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [leaseId, processId] of [
          ["live-process", process.pid],
          ["pending-process", null],
          ["terminated-process", 2_147_483_647],
        ] as const) {
          yield* insertProjectionThreadParent({
            sql,
            threadId: ThreadId.makeUnsafe(leaseId),
          });
          yield* sql`
          INSERT INTO worktree_runtime_leases (
            lease_id, thread_id, runtime_kind, canonical_path, device, inode,
            process_id, acquired_at, updated_at
          ) VALUES (${leaseId}, ${leaseId}, 'terminal', ${`/tmp/${leaseId}`}, 1,
            ${leaseId === "live-process" ? 1 : leaseId === "pending-process" ? 2 : 3},
            ${processId}, '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z')
        `;
        }

        yield* reconcileWorktreeRuntimeLeases(sql, "terminal");
        const rows = yield* sql<{ readonly leaseId: string }>`
        SELECT lease_id AS "leaseId" FROM worktree_runtime_leases ORDER BY lease_id
      `;
        assert.deepEqual(rows, [{ leaseId: "live-process" }, { leaseId: "pending-process" }]);
      }),
  );
});
import * as nodeFs from "node:fs/promises";

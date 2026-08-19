import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../Layers/ProjectionThread.test.helpers.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("089_ThreadDelegationsOwnership", (it) => {
  it.effect("removes delegation rows when either thread endpoint is deleted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 88 });
      yield* sql`DELETE FROM thread_delegations`;
      for (const threadId of ["caller", "child", "keep"]) {
        yield* insertProjectionThreadParent({ sql, threadId: ThreadId.makeUnsafe(threadId) });
      }
      yield* sql`
        INSERT INTO thread_delegations (
          delegation_id, caller_thread_id, source_message_id, invocation_id,
          root_delegation_id, depth, target_kind, child_thread_id, child_turn_id,
          state, created_at, updated_at
        ) VALUES (
          'delegation', 'caller', 'message', 'invocation', 'delegation', 0,
         'thread', 'child', 'turn', 'running', 'now', 'now'
        )
      `;
      yield* sql`
        INSERT INTO thread_delegations (
          delegation_id, caller_thread_id, source_message_id, invocation_id,
          root_delegation_id, depth, target_kind, child_thread_id, child_turn_id,
          state, created_at, updated_at
        ) VALUES (
          'orphan-delegation', 'missing', 'message', 'invocation-2', 'orphan-delegation', 0,
          'thread', 'orphan-child', 'turn', 'running', 'now', 'now'
        )
      `;
      yield* runMigrations();
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(
        yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'trigger' AND name IN (
            'thread_retention_guard_delegation_insert',
            'thread_retention_guard_delegation_activate'
          )
          ORDER BY name
        `,
        [
          { name: "thread_retention_guard_delegation_activate" },
          { name: "thread_retention_guard_delegation_insert" },
        ],
      );
      assert.deepEqual(yield* sql`SELECT delegation_id FROM thread_delegations`, [
        { delegation_id: "delegation" },
      ]);
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'child'`;
      assert.deepEqual(yield* sql`SELECT delegation_id FROM thread_delegations`, []);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});

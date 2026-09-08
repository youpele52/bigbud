import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../Layers/ProjectionThread.test.helpers.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("098_ThreadDelegationReservationOwnership", (it) => {
  it.effect("allows a reservation before its child projection exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 97 });
      yield* insertProjectionThreadParent({ sql, threadId: ThreadId.makeUnsafe("caller") });
      yield* runMigrations();
      yield* sql`
        INSERT INTO thread_delegations (
          delegation_id, caller_thread_id, source_message_id, invocation_id,
          root_delegation_id, depth, target_kind, child_thread_id, child_turn_id,
          state, created_at, updated_at
        ) VALUES (
          'pending', 'caller', 'message', 'invocation', 'pending', 0,
          'project', 'child', 'turn', 'reserved', 'now', 'now'
        )
      `;
      assert.deepEqual(yield* sql`SELECT delegation_id FROM thread_delegations`, [
        { delegation_id: "pending" },
      ]);

      yield* insertProjectionThreadParent({ sql, threadId: ThreadId.makeUnsafe("child") });
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'child'`;
      assert.deepEqual(yield* sql`SELECT delegation_id FROM thread_delegations`, []);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});

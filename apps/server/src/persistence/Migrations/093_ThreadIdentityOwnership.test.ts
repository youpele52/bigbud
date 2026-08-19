import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../Layers/ProjectionThread.test.helpers.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("093_ThreadIdentityOwnership", (it) => {
  it.effect("cascades orchestration identities with their projection thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 92 });
      for (const threadId of ["delete", "keep"]) {
        yield* insertProjectionThreadParent({ sql, threadId: ThreadId.makeUnsafe(threadId) });
      }
      yield* sql`
        INSERT INTO orchestration_thread_identity (thread_id, project_id, created_sequence)
        VALUES ('delete', 'project', 1), ('keep', 'project', 2)
      `;

      yield* runMigrations({ toMigrationInclusive: 93 });
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'delete'`;

      assert.deepEqual(yield* sql`SELECT thread_id FROM orchestration_thread_identity`, [
        { thread_id: "keep" },
      ]);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});

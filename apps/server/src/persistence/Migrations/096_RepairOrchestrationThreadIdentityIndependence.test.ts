import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { insertProjectionThreadParent } from "../Layers/ProjectionThread.test.helpers.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "096_RepairOrchestrationThreadIdentityIndependence - current schema",
  (it) => {
    it.effect("records identity before a projection thread exists and keeps it after delete", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 96 });

        assert.deepEqual(
          yield* sql.unsafe(
            `SELECT "table", "from", "to" FROM pragma_foreign_key_list('orchestration_thread_identity')`,
          ),
          [],
        );

        yield* sql`
          INSERT INTO orchestration_thread_identity (thread_id, project_id, created_sequence)
          VALUES ('new-thread', 'project', 1)
        `;
        yield* insertProjectionThreadParent({
          sql,
          threadId: ThreadId.makeUnsafe("new-thread"),
          projectId: "project",
        });
        yield* sql`DELETE FROM projection_threads WHERE thread_id = 'new-thread'`;
        assert.deepEqual(yield* sql`SELECT thread_id FROM orchestration_thread_identity`, [
          { thread_id: "new-thread" },
        ]);
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "096_RepairOrchestrationThreadIdentityIndependence - recorded 093 schema",
  (it) => {
    it.effect("removes the projection-thread foreign key added by 093", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 95 });
        assert.deepEqual(
          yield* sql.unsafe(
            `SELECT "table" FROM pragma_foreign_key_list('orchestration_thread_identity')`,
          ),
          [{ table: "projection_threads" }],
        );

        yield* runMigrations();

        assert.deepEqual(
          yield* sql.unsafe(
            `SELECT "table" FROM pragma_foreign_key_list('orchestration_thread_identity')`,
          ),
          [],
        );
        yield* sql`
          INSERT INTO orchestration_thread_identity (thread_id, project_id, created_sequence)
          VALUES ('created-before-projection', 'project', 2)
        `;
      }),
    );
  },
);

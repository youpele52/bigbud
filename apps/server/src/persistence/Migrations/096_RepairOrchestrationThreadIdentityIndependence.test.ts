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

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "096_RepairOrchestrationThreadIdentityIndependence - legacy deleted identity",
  (it) => {
    it.effect("preserves deletion evidence after the 093 identity cascade", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("legacy-deleted-thread");
        yield* runMigrations({ toMigrationInclusive: 92 });
        yield* insertProjectionThreadParent({ sql, threadId, projectId: "legacy-project" });
        yield* sql`
          INSERT INTO orchestration_thread_identity (thread_id, project_id, created_sequence)
          VALUES (${threadId}, 'legacy-project', 10)
        `;
        yield* sql`
          INSERT INTO orchestration_deletion_markers (
            entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
          ) VALUES ('thread', ${threadId}, 11, '2026-08-26T10:02:35.000Z', NULL)
        `;
        yield* runMigrations({ toMigrationInclusive: 93 });
        yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
        yield* runMigrations();

        assert.deepEqual(
          yield* sql`
            SELECT entity_id AS "entityId", deletion_sequence AS "deletionSequence"
            FROM orchestration_deletion_markers WHERE entity_id = ${threadId}
          `,
          [{ entityId: threadId, deletionSequence: 11 }],
        );
        assert.deepEqual(
          yield* sql`
            SELECT thread_id FROM orchestration_thread_identity WHERE thread_id = ${threadId}
          `,
          [],
        );
      }),
    );
  },
);

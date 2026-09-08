import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../Layers/ProjectionThread.test.helpers.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("099_ParentDeletionUpdateGuard", (it) => {
  it.effect("allows unchanged child ownership while rejecting new children", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* insertProjectionThreadParent({
        sql,
        threadId: ThreadId.makeUnsafe("deleting-parent"),
      });
      yield* insertProjectionThreadParent({ sql, threadId: ThreadId.makeUnsafe("existing-child") });
      yield* insertProjectionThreadParent({ sql, threadId: ThreadId.makeUnsafe("new-child") });
      yield* sql`
        UPDATE projection_threads
        SET parent_thread_id = 'deleting-parent', parent_thread_title = 'Parent'
        WHERE thread_id = 'existing-child'
      `;
      yield* sql`
        UPDATE projection_threads SET deleting_at = 'now'
        WHERE thread_id = 'deleting-parent'
      `;

      yield* sql`
        UPDATE projection_threads
        SET parent_thread_id = parent_thread_id, updated_at = 'later'
        WHERE thread_id = 'existing-child'
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, parent_thread_id, parent_thread_title, created_at, updated_at
        ) VALUES (
          'existing-child', 'test-project', 'Existing child',
          '{"provider":"codex","model":"test"}', 'full-access', 'default',
          'deleting-parent', 'Parent', 'now', 'later'
        ) ON CONFLICT(thread_id) DO UPDATE SET updated_at = excluded.updated_at,
          parent_thread_id = excluded.parent_thread_id
      `;
      assert.equal(
        (yield* sql<{ parentThreadId: string | null }>`
            SELECT parent_thread_id AS "parentThreadId"
            FROM projection_threads WHERE thread_id = 'existing-child'
          `)[0]?.parentThreadId,
        "deleting-parent",
      );

      assert.equal(
        (yield* Effect.exit(sql`
            UPDATE projection_threads
            SET parent_thread_id = 'deleting-parent', parent_thread_title = 'Parent'
            WHERE thread_id = 'new-child'
          `))._tag,
        "Failure",
      );
    }),
  );
});

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("081_ProjectionThreadOwnership", (it) => {
  it.effect("removes historic orphans and cascades only owned projection rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES
          ('delete-parent', 'project', 'Delete', '{"provider":"codex","model":"test"}', 'full-access', 'default', 'now', 'now'),
          ('keep-parent', 'project', 'Keep', '{"provider":"codex","model":"test"}', 'full-access', 'default', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('delete-message', 'delete-parent', 'user', '', 0, 'now', 'now'),
          ('keep-message', 'keep-parent', 'user', '', 0, 'now', 'now'),
          ('orphan-message', 'orphan', 'user', '', 0, 'now', 'now')
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
        VALUES ('delete-activity', 'delete-parent', 'info', 'test', '', '{}', 'now'),
          ('keep-activity', 'keep-parent', 'info', 'test', '', '{}', 'now'),
          ('orphan-activity', 'orphan', 'info', 'test', '', '{}', 'now')
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id, provider_thread_id,
          runtime_mode, active_turn_id, reason, last_error, updated_at
        ) VALUES
          ('delete-parent', 'stopped', 'codex', 'session-delete', 'thread-delete', 'full-access', 'turn-delete', 'done', 'none', 'now'),
          ('keep-parent', 'stopped', 'codex', 'session-keep', 'thread-keep', 'read-only', 'turn-keep', 'paused', 'none', 'now'),
          ('orphan', 'stopped', 'codex', 'session-orphan', 'thread-orphan', 'full-access', NULL, 'orphan', NULL, 'now')
      `;

      yield* runMigrations();

      const orphans = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = 'orphan') +
          (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = 'orphan') +
          (SELECT COUNT(*) FROM projection_thread_sessions WHERE thread_id = 'orphan') AS count
      `;
      assert.deepEqual(orphans, [{ count: 0 }]);
      assert.deepEqual(
        yield* sql`
          SELECT provider_session_id, provider_thread_id, runtime_mode, active_turn_id, reason, last_error
          FROM projection_thread_sessions WHERE thread_id = 'keep-parent'
        `,
        [
          {
            provider_session_id: "session-keep",
            provider_thread_id: "thread-keep",
            runtime_mode: "read-only",
            active_turn_id: "turn-keep",
            reason: "paused",
            last_error: "none",
          },
        ],
      );
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
      const triggers = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name IN (
          'projection_thread_attachment_refs_message_insert',
          'projection_thread_attachment_refs_activity_insert'
        )
        ORDER BY name
      `;
      assert.deepEqual(triggers, [
        { name: "projection_thread_attachment_refs_activity_insert" },
        { name: "projection_thread_attachment_refs_message_insert" },
      ]);

      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'delete-parent'`;
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = 'keep-parent') +
          (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = 'keep-parent') +
          (SELECT COUNT(*) FROM projection_thread_sessions WHERE thread_id = 'keep-parent') AS count
      `;
      const deleted = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = 'delete-parent') +
          (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = 'delete-parent') +
          (SELECT COUNT(*) FROM projection_thread_sessions WHERE thread_id = 'delete-parent') AS count
      `;
      assert.deepEqual(remaining, [{ count: 3 }]);
      assert.deepEqual(deleted, [{ count: 0 }]);
    }),
  );
});

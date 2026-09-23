import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("120_ProjectionMessageSearch", (it) => {
  it.effect(
    "backfills existing messages and tracks replay, replacement, and cascade deletion",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* runMigrations({ toMigrationInclusive: 119 });
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project', 'Project', '/project', '[]', '2026-01-01', '2026-01-01')
      `;
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES ('thread', 'project', 'Thread',
          '{"provider":"codex","model":"test"}', 'full-access', 'default',
          '2026-01-01', '2026-01-01')
      `;
        yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('message', 'thread', 'user', 'DeepSeek Harness', 0, '2026-01-01', '2026-01-01')
      `;
        yield* runMigrations();
        const find = (term: string) => sql<{ readonly rowid: number }>`
        SELECT rowid FROM projection_message_search WHERE projection_message_search MATCH ${term}
      `;
        assert.lengthOf(yield* find('"seek"'), 1);
        yield* sql`UPDATE projection_thread_messages SET text = 'Changed text' WHERE message_id = 'message'`;
        assert.lengthOf(yield* find('"seek"'), 0);
        assert.lengthOf(yield* find('"hang"'), 1);
        yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = 'thread'`;
        assert.lengthOf(yield* find('"hang"'), 0);
        yield* sql`INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES ('message', 'thread', 'user', 'Replay text', 0, '2026-01-01', '2026-01-01')`;
        assert.lengthOf(yield* find('"play"'), 1);
        yield* sql`UPDATE projection_thread_messages SET is_streaming = 1 WHERE message_id = 'message'`;
        assert.lengthOf(yield* find('"play"'), 0);
        yield* sql`UPDATE projection_thread_messages SET text = 'Replay final', is_streaming = 0
        WHERE message_id = 'message'`;
        assert.lengthOf(yield* find('"play"'), 1);
        yield* sql`DELETE FROM projection_threads WHERE thread_id = 'thread'`;
        assert.lengthOf(yield* find('"play"'), 0);
      }),
  );
});

it("retains the index and update triggers across a database restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bigbud-message-search-"));
  const filename = join(directory, "state.sqlite");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* runMigrations();
        yield* sql`INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project', 'Project', '/project', '[]', '2026-01-01', '2026-01-01')`;
        yield* sql`INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES ('thread', 'project', 'Thread',
          '{"provider":"codex","model":"test"}', 'full-access', 'default',
          '2026-01-01', '2026-01-01')`;
        yield* sql`INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('message', 'thread', 'user', 'Restartable search', 0, '2026-01-01', '2026-01-01')`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* runMigrations();
        const original = yield* sql`SELECT rowid FROM projection_message_search
          WHERE projection_message_search MATCH '"startable"'`;
        assert.lengthOf(original, 1);
        yield* sql`UPDATE projection_thread_messages SET text = 'Replayed value'
          WHERE message_id = 'message'`;
        const removed = yield* sql`SELECT rowid FROM projection_message_search
          WHERE projection_message_search MATCH '"startable"'`;
        const replacement = yield* sql`SELECT rowid FROM projection_message_search
          WHERE projection_message_search MATCH '"played"'`;
        assert.lengthOf(removed, 0);
        assert.lengthOf(replacement, 1);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

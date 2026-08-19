import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@bigbud/contracts";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../Layers/ProjectionThread.test.helpers.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("088_ProjectionThreadWatchesOwnership", (it) => {
  it.effect("removes watches when either endpoint is deleted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 87 });
      for (const threadId of ["watcher", "watched", "keep"]) {
        yield* insertProjectionThreadParent({
          sql,
          threadId: ThreadId.makeUnsafe(threadId),
        });
      }
      yield* sql`
        INSERT INTO projection_thread_watches
          (watch_id, watcher_thread_id, watched_thread_id, watched_thread_title, source_message_id, status, created_at)
        VALUES ('watch-1', 'watcher', 'watched', 'Watched', 'message', 'active', 'now')
      `;
      yield* sql`
        INSERT INTO projection_thread_watches
          (watch_id, watcher_thread_id, watched_thread_id, watched_thread_title, source_message_id, status, created_at)
        VALUES ('watch-orphan', 'missing', 'watched', 'Watched', 'message', 'active', 'now')
      `;
      yield* runMigrations();
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(
        yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'trigger' AND name IN (
            'thread_retention_guard_watch_insert',
            'thread_retention_guard_watch_activate'
          )
          ORDER BY name
        `,
        [
          { name: "thread_retention_guard_watch_activate" },
          { name: "thread_retention_guard_watch_insert" },
        ],
      );
      assert.deepEqual(yield* sql`SELECT watch_id FROM projection_thread_watches`, [
        { watch_id: "watch-1" },
      ]);
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'watched'`;
      assert.deepEqual(yield* sql`SELECT watch_id FROM projection_thread_watches`, []);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});

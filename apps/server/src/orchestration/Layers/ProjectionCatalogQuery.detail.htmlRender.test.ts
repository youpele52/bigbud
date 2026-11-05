import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

it.layer(ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "HTML history",
  (it) => {
    it.effect(
      "loads durable renders with their historical message window, not only latest-turn activities",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const query = yield* ProjectionCatalogQuery;
          yield* sql`INSERT INTO projection_threads (
      thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
      interaction_mode, latest_turn_id, created_at, updated_at
    ) VALUES ('html-thread', 'project', 'HTML', 'standard',
      '{"provider":"codex","model":"test"}', 'full-access', 'default', 'current',
      '2026-11-04T10:00:00.000Z', '2026-11-04T10:05:00.000Z')`;
          yield* sql`INSERT INTO projection_thread_messages (
      message_id, thread_id, role, text, is_streaming, created_at, updated_at
    ) VALUES
      ('new', 'html-thread', 'user', 'Latest', 0, '2026-11-04T10:04:00.000Z', '2026-11-04T10:04:00.000Z'),
      ('old', 'html-thread', 'user', 'Previous', 0, '2026-11-04T10:00:00.000Z', '2026-11-04T10:00:00.000Z')`;
          const payload = { title: "Chart", html: "<p>Durable</p>" };
          yield* sql`INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    ) VALUES ('render', 'html-thread', 'old', 'info', 'html.render.published', 'Chart', ${JSON.stringify(payload)}, 1, '2026-11-04T10:01:00.000Z')`;
          const first = yield* query.getSelectedThreadDetail({
            threadId: ThreadId.makeUnsafe("html-thread"),
            messageLimit: 1,
            activityLimit: 1,
          });
          assert.equal(first.activities.length, 0);
          const older = yield* query.getSelectedThreadDetail({
            threadId: ThreadId.makeUnsafe("html-thread"),
            messageLimit: 1,
            activityLimit: 1,
            messageCursor: first.messageWindow.nextCursor!,
          });
          assert.equal(older.activities.length, 1);
          assert.deepEqual(older.activities[0]?.payload, payload);
          const reload = yield* query.getSelectedThreadDetail({
            threadId: ThreadId.makeUnsafe("html-thread"),
            activityLimit: 1,
          });
          assert.deepEqual(reload.activities, older.activities);
        }),
    );
  },
);

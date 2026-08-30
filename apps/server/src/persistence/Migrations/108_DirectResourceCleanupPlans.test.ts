import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("108_DirectResourceCleanupPlans", (it) => {
  it.effect("backfills open deletion projections and inserts future intents without ignore", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-29T00:00:00.000Z";
      yield* runMigrations({ toMigrationInclusive: 107 });
      yield* insertDeletingProject(sql, "before", now);
      yield* insertDeletionEvent(sql, "before", now);

      yield* runMigrations();
      assert.deepEqual(yield* readIntents(sql), [
        {
          eventId: "event-before",
          entityId: "before",
          digestVersion: "legacy/unavailable",
          digest: "unavailable",
        },
      ]);

      yield* insertDeletingProject(sql, "after", now);
      yield* insertDeletionEvent(sql, "after", now);
      assert.deepEqual(yield* readIntents(sql), [
        {
          eventId: "event-after",
          entityId: "after",
          digestVersion: "legacy/unavailable",
          digest: "unavailable",
        },
        {
          eventId: "event-before",
          entityId: "before",
          digestVersion: "legacy/unavailable",
          digest: "unavailable",
        },
      ]);
    }),
  );
});

function insertDeletingProject(sql: SqlClient.SqlClient, id: string, now: string) {
  return sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleting_at
    ) VALUES (${id}, ${id}, '/tmp', '[]', ${now}, ${now}, ${now})
  `;
}

function insertDeletionEvent(sql: SqlClient.SqlClient, id: string, now: string) {
  return sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, actor_kind, payload_json, metadata_json
    ) VALUES (
      ${`event-${id}`}, 'project', ${id}, 1, 'project.deletion-requested', ${now},
      ${`command-${id}`}, 'user', ${JSON.stringify({ projectId: id })}, '{}'
    )
  `;
}

function readIntents(sql: SqlClient.SqlClient) {
  return sql`
    SELECT event_id AS "eventId", entity_id AS "entityId",
      source_payload_digest_version AS "digestVersion", source_payload_digest AS digest
    FROM direct_resource_cleanup_intents ORDER BY event_id
  `;
}

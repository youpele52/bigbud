import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("078_BackfillDeletionMarkers", (it) => {
  it.effect("backfills missing markers from canonical deletion events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 77 });
      yield* sql`
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version,
        event_type, occurred_at, actor_kind, payload_json, metadata_json
      ) VALUES
        (1, 'event-1', 'thread', 'thread-1', 1, 'thread.deleted', '2026-01-01T00:00:00.000Z', 'system', '{}', '{}'),
        (2, 'event-2', 'thread', 'thread-1', 2, 'thread.deleted', '2026-01-01T00:01:00.000Z', 'system', '{}', '{}'),
        (3, 'event-3', 'project', 'project-1', 1, 'project.deleted', '2026-01-01T00:02:00.000Z', 'system', '{}', '{}'),
        (4, 'event-4', 'thread', 'thread-2', 1, 'thread.created', '2026-01-01T00:03:00.000Z', 'system', '{}', '{}')
    `;
      yield* sql`
      INSERT INTO orchestration_deletion_markers VALUES
        ('thread', 'thread-1', 99, 'existing', NULL)
    `;

      yield* runMigrations();

      const rows = yield* sql`
      SELECT entity_kind AS "entityKind", entity_id AS "entityId",
        deletion_sequence AS "deletionSequence", deleted_at AS "deletedAt"
      FROM orchestration_deletion_markers
      ORDER BY entity_kind, entity_id
    `;
      assert.deepEqual(rows, [
        {
          entityKind: "project",
          entityId: "project-1",
          deletionSequence: 3,
          deletedAt: "2026-01-01T00:02:00.000Z",
        },
        {
          entityKind: "thread",
          entityId: "thread-1",
          deletionSequence: 99,
          deletedAt: "existing",
        },
      ]);
    }),
  );
});

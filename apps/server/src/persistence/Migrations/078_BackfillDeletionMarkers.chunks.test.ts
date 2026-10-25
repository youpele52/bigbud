import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { EVENT_BACKFILL_CHUNK_SIZE } from "./EventSequenceChunks.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const EVENT_COUNT = 60_000;

layer("078_BackfillDeletionMarkers across backfill chunks", (it) => {
  it.effect("keeps per-entity maxima and pre-existing markers across chunk boundaries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.isAbove(EVENT_COUNT, EVENT_BACKFILL_CHUNK_SIZE * 2);
      yield* runMigrations({ toMigrationInclusive: 77 });
      // Deletions sit in different chunks; thread-d's later sequence carries an earlier time.
      yield* sql`
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${EVENT_COUNT}),
        chosen(x, kind, stream, event_type, occurred_at) AS (VALUES
          (100, 'thread', 'thread-a', 'thread.deleted', '2026-01-01T00:00:00.000Z'),
          (40000, 'thread', 'thread-a', 'thread.deleted', '2026-01-03T00:00:00.000Z'),
          (30000, 'project', 'project-b', 'project.deleted', '2026-01-02T00:00:00.000Z'),
          (50000, 'thread', 'thread-c', 'thread.deleted', '2026-01-04T00:00:00.000Z'),
          (200, 'thread', 'thread-d', 'thread.deleted', '2026-02-01T00:00:00.000Z'),
          (55000, 'thread', 'thread-d', 'thread.deleted', '2026-01-15T00:00:00.000Z'))
        INSERT INTO orchestration_events (
          sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        )
        SELECT n.x, 'event-' || n.x, COALESCE(chosen.kind, 'thread'),
          COALESCE(chosen.stream, 'filler'), n.x,
          COALESCE(chosen.event_type, 'thread.message-sent'),
          COALESCE(chosen.occurred_at, '2026-01-01T00:00:00.000Z'), 'system', '{}', '{}'
        FROM n LEFT JOIN chosen ON chosen.x = n.x
      `;
      yield* sql`
        INSERT INTO orchestration_deletion_markers VALUES ('thread', 'thread-c', 99, 'existing', NULL)
      `;

      yield* runMigrations({ toMigrationInclusive: 78 });

      const rows = yield* sql`
        SELECT entity_kind AS "kind", entity_id AS "id",
          deletion_sequence AS "sequence", deleted_at AS "deletedAt"
        FROM orchestration_deletion_markers ORDER BY entity_kind, entity_id
      `;
      assert.deepEqual(rows, [
        {
          kind: "project",
          id: "project-b",
          sequence: 30000,
          deletedAt: "2026-01-02T00:00:00.000Z",
        },
        { kind: "thread", id: "thread-a", sequence: 40000, deletedAt: "2026-01-03T00:00:00.000Z" },
        { kind: "thread", id: "thread-c", sequence: 99, deletedAt: "existing" },
        { kind: "thread", id: "thread-d", sequence: 55000, deletedAt: "2026-02-01T00:00:00.000Z" },
      ]);
    }),
  );
});

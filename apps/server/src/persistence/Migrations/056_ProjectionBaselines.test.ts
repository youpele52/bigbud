import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./056_ProjectionBaselines.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("056_ProjectionBaselines", (it) => {
  it.effect("creates durable baseline, retention, stream, and deletion proof storage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES ('event-056', 'project', 'project-056', 7, 'project.deleted',
          '2026-07-30T00:00:00.000Z', NULL, NULL, NULL, 'server', '{}', '{}')
      `;

      yield* migration;
      yield* migration;

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
          'projection_baselines', 'orchestration_retention_state',
          'orchestration_stream_state', 'orchestration_deletion_markers',
          'orchestration_event_ids'
        ) ORDER BY name
      `;
      assert.equal(tables.length, 5);
      const retention = yield* sql<{ readonly retained: number; readonly target: number }>`
        SELECT retained_through_sequence AS retained, compact_through_sequence AS target
        FROM orchestration_retention_state
      `;
      assert.deepEqual(retention, [{ retained: 0, target: 0 }]);
      const streams = yield* sql<{ readonly version: number }>`
        SELECT last_stream_version AS version FROM orchestration_stream_state
        WHERE aggregate_kind = 'project' AND stream_id = 'project-056'
      `;
      assert.deepEqual(streams, [{ version: 7 }]);
      const eventIds = yield* sql<{ readonly eventId: string }>`
        SELECT event_id AS "eventId" FROM orchestration_event_ids
      `;
      assert.deepEqual(eventIds, [{ eventId: "event-056" }]);
    }),
  );
});

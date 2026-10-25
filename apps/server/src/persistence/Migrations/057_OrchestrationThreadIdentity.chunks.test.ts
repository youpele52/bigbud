import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./057_OrchestrationThreadIdentity.ts";
import { EVENT_BACKFILL_CHUNK_SIZE } from "./EventSequenceChunks.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const EVENT_COUNT = 60_000;

layer("057_OrchestrationThreadIdentity across backfill chunks", (it) => {
  it.effect("keeps the earliest creation per thread when duplicates span chunks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.isAbove(EVENT_COUNT, EVENT_BACKFILL_CHUNK_SIZE * 2);
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${EVENT_COUNT}),
        chosen(x, stream, event_type, payload) AS (VALUES
          (100, 'thread-x', 'thread.created', '{"projectId":"project-first"}'),
          (40000, 'thread-x', 'thread.created', '{"projectId":"project-later"}'),
          (30000, 'thread-y', 'thread.created', '{"projectId":"project-y"}'),
          (50000, 'thread-z', 'thread.created', '{}'))
        INSERT INTO orchestration_events (
          sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        )
        SELECT n.x, 'event-' || n.x, 'thread', COALESCE(chosen.stream, 'filler'), n.x,
          COALESCE(chosen.event_type, 'thread.message-sent'), '2026-01-01T00:00:00.000Z',
          'system', COALESCE(chosen.payload, '{}'), '{}'
        FROM n LEFT JOIN chosen ON chosen.x = n.x
      `;

      yield* migration;

      const identities = yield* sql`
        SELECT thread_id AS "threadId", project_id AS "projectId",
          created_sequence AS "createdSequence"
        FROM orchestration_thread_identity ORDER BY thread_id
      `;
      assert.deepEqual(identities, [
        { threadId: "thread-x", projectId: "project-first", createdSequence: 100 },
        { threadId: "thread-y", projectId: "project-y", createdSequence: 30000 },
      ]);
    }),
  );
});

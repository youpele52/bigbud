import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "104_ThreadIdentityLatestMaterialization",
  (it) => {
    it.effect("records the latest allowed materialization after deletion", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 103 });
        yield* sql`
          INSERT INTO orchestration_thread_identity (thread_id, project_id, created_sequence)
          VALUES ('recreated-thread', 'old-project', 1)
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            sequence, event_id, aggregate_kind, stream_id, stream_version,
            event_type, occurred_at, actor_kind, payload_json, metadata_json
          ) VALUES (
            3, 'recreated-event', 'thread', 'recreated-thread', 3,
            'thread.created', '2026-08-26T00:00:00.000Z', 'user',
            '{"projectId":"new-project"}', '{}'
          )
        `;

        yield* runMigrations();

        assert.deepEqual(
          yield* sql`
            SELECT project_id AS "projectId", created_sequence AS "createdSequence"
            FROM orchestration_thread_identity WHERE thread_id = 'recreated-thread'
          `,
          [{ projectId: "new-project", createdSequence: 3 }],
        );
      }),
    );
  },
);

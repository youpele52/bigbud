import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./057_OrchestrationThreadIdentity.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("057_OrchestrationThreadIdentity", (it) => {
  it.effect("preserves canonical thread project identity for compacted events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES ('event-057', 'thread', 'thread-057', 0, 'thread.created',
          '2026-07-30T00:00:00.000Z', NULL, NULL, NULL, 'server',
          '{"projectId":"project-057"}', '{}')
      `;
      yield* migration;

      const identities = yield* sql<{ readonly projectId: string }>`
        SELECT project_id AS "projectId" FROM orchestration_thread_identity
        WHERE thread_id = 'thread-057'
      `;
      assert.deepEqual(identities, [{ projectId: "project-057" }]);
    }),
  );
});

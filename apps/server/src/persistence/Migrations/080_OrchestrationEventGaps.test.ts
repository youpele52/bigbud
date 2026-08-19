import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("080_OrchestrationEventGaps", (it) => {
  it.effect("records sparse canonical deletion gaps", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      yield* runMigrations();
      yield* sql`
        INSERT INTO orchestration_event_gaps (sequence, event_id, created_at)
        VALUES (17, 'deleted-event', '2026-08-18T00:00:00.000Z')
      `;
      assert.deepEqual(yield* sql`SELECT sequence, event_id FROM orchestration_event_gaps`, [
        { sequence: 17, event_id: "deleted-event" },
      ]);
    }),
  );
});

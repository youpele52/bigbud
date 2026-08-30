import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import repairOrchestrationEventIdSequences from "./109_RepairOrchestrationEventIdSequences.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "109_RepairOrchestrationEventIdSequences",
  (it) => {
    it.effect("repairs unambiguous event and gap ledger sequences idempotently", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-08-30T00:00:00.000Z";
        yield* runMigrations({ toMigrationInclusive: 108 });
        yield* sql`
          INSERT INTO orchestration_events (
            sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json
          ) VALUES (7, 'event-retained', 'project', 'project-retained', 0,
            'project.created', ${now}, 'server', '{}', '{}')
        `;
        yield* sql`
          INSERT INTO orchestration_event_gaps (sequence, event_id, created_at)
          VALUES (8, 'event-purged', ${now})
        `;
        yield* sql`
          INSERT INTO orchestration_event_ids (event_id, sequence) VALUES
            ('event-retained', 5), ('event-purged', 6), ('event-orphan', 99)
        `;

        yield* repairOrchestrationEventIdSequences;
        yield* repairOrchestrationEventIdSequences;

        assert.deepEqual(
          yield* sql`
            SELECT event_id AS "eventId", sequence
            FROM orchestration_event_ids ORDER BY event_id
          `,
          [
            { eventId: "event-orphan", sequence: 99 },
            { eventId: "event-purged", sequence: 8 },
            { eventId: "event-retained", sequence: 7 },
          ],
        );
      }),
    );
  },
);

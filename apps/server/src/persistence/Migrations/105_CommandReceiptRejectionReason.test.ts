import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "105_CommandReceiptRejectionReason",
  (it) => {
    it.effect("preserves legacy receipts with an unclassified rejection reason", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 104 });
        yield* sql`
          INSERT INTO orchestration_command_receipts (
            command_id, aggregate_kind, aggregate_id, accepted_at,
            result_sequence, status, error
          ) VALUES (
            'legacy-command', 'thread', 'thread-1', '2026-08-26T12:00:00.000Z',
            7, 'rejected', 'private legacy detail'
          )
        `;

        yield* runMigrations();

        assert.deepEqual(
          yield* sql`
            SELECT rejection_reason AS "rejectionReason"
            FROM orchestration_command_receipts
            WHERE command_id = 'legacy-command'
          `,
          [{ rejectionReason: null }],
        );
      }),
    );
  },
);

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "106_CommandReceiptPayloadDigest",
  (it) => {
    it.effect("preserves legacy receipts and creates the durable digest claim table", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 105 });
        yield* sql`
          INSERT INTO orchestration_command_receipts (
            command_id, aggregate_kind, aggregate_id, accepted_at,
            result_sequence, status, rejection_reason, error
          ) VALUES (
            'legacy-command', 'thread', 'thread-1', '2026-08-26T12:00:00.000Z',
            7, 'accepted', NULL, NULL
          )
        `;

        yield* runMigrations();
        yield* sql`
          INSERT INTO orchestration_command_receipt_claims (
            command_id, payload_digest_version, payload_digest, claimed_at
          ) VALUES (
            'claimed-command', 'orchestration-command-payload/v1', 'digest-a',
            '2026-08-27T00:00:00.000Z'
          )
        `;

        assert.deepEqual(
          yield* sql`
            SELECT
              payload_digest_version AS "payloadDigestVersion",
              payload_digest AS "payloadDigest"
            FROM orchestration_command_receipts
            WHERE command_id = 'legacy-command'
          `,
          [{ payloadDigestVersion: null, payloadDigest: null }],
        );
        assert.deepEqual(
          yield* sql`
            SELECT payload_digest AS "payloadDigest"
            FROM orchestration_command_receipt_claims
            WHERE command_id = 'claimed-command'
          `,
          [{ payloadDigest: "digest-a" }],
        );
      }),
    );
  },
);

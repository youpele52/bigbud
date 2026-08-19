import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("097_ThreadRetentionFinitePolicies", (it) => {
  it.effect("rejects 3-days challenges before the policy check is widened", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 96 });
      const rejected = yield* Effect.exit(sql`
        INSERT INTO thread_retention_consent_challenges (
          challenge_id, token_hash, trigger_kind, policy, cutoff_at, expires_at, issued_at
        ) VALUES (
          'three-day-preview', 'hash', 'manual', '3-days',
          '2026-08-16T00:00:00.000Z', '2026-08-19T12:00:00.000Z', '2026-08-19T11:55:00.000Z'
        )
      `);
      assert.equal(Exit.isFailure(rejected), true);
    }),
  );

  it.effect("accepts 1-day, 2-days, and 3-days after widening the policy check", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 96 });
      yield* sql`
        INSERT INTO thread_retention_consent_challenges (
          challenge_id, token_hash, trigger_kind, policy, cutoff_at, expires_at, issued_at
        ) VALUES (
          'seven-day-preview', 'hash-7', 'manual', '7-days',
          '2026-08-12T00:00:00.000Z', '2026-08-19T12:00:00.000Z', '2026-08-19T11:55:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO thread_retention_runs (
          run_id, trigger_kind, policy, cutoff_at, status, created_at, updated_at
        ) VALUES (
          'seven-day-run', 'manual', '7-days', '2026-08-12T00:00:00.000Z',
          'queued', '2026-08-19T11:55:00.000Z', '2026-08-19T11:55:00.000Z'
        )
      `;

      yield* runMigrations();

      for (const policy of ["1-day", "2-days", "3-days"] as const) {
        yield* sql`
          INSERT INTO thread_retention_consent_challenges (
            challenge_id, token_hash, trigger_kind, policy, cutoff_at, expires_at, issued_at
          ) VALUES (
            ${`preview-${policy}`}, ${`hash-${policy}`}, 'manual', ${policy},
            '2026-08-16T00:00:00.000Z', '2026-08-19T12:00:00.000Z', '2026-08-19T11:55:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO thread_retention_runs (
            run_id, trigger_kind, policy, cutoff_at, status, created_at, updated_at
          ) VALUES (
            ${`run-${policy}`}, 'manual', ${policy}, '2026-08-16T00:00:00.000Z',
            'queued', '2026-08-19T11:55:00.000Z', '2026-08-19T11:55:00.000Z'
          )
        `;
      }
      yield* sql`
        INSERT INTO thread_retention_policy_authority (singleton_id, policy, source, updated_at)
        VALUES (1, '3-days', 'explicit', '2026-08-19T11:55:00.000Z')
      `;
      assert.deepEqual(
        yield* sql<{ policy: string }>`
          SELECT policy FROM thread_retention_consent_challenges ORDER BY policy
        `.pipe(Effect.map((rows) => rows.map((row) => row.policy))),
        ["1-day", "2-days", "3-days", "7-days"],
      );
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }),
  );
});

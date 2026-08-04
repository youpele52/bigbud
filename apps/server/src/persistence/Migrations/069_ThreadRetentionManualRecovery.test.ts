import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("069_ThreadRetentionManualRecovery", (it) => {
  it.effect("keeps foreign-key parents intact and disables automatic recovery", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* sql`
        INSERT INTO purge_jobs (
          job_id, entity_kind, entity_id, phase, status, resource_manifest_json,
          last_error, created_at, updated_at
        ) VALUES ('manual-job', 'thread', 'thread-1', 'files', 'failed', '[]',
          'manual_recovery_required', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO purge_resource_claims (
          job_id, entity_kind, entity_id, resource_kind, relative_path, canonical_path,
          device, inode, resource_type, claimed_at
        ) VALUES (
          'manual-job', 'thread', 'thread-1', 'attachment', 'attachment-1.png',
          '/attachments/attachment-1.png', 1, 1, 'file', 'now'
        )
      `;

      yield* runMigrations();

      const legacyTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'purge_jobs_legacy'
      `;
      const foreignKeyErrors = yield* sql`PRAGMA foreign_key_check`;
      const job = yield* sql<{ readonly disabled: number }>`
        SELECT auto_resume_disabled AS disabled FROM purge_jobs WHERE job_id = 'manual-job'
      `;
      assert.deepEqual(legacyTables, []);
      assert.deepEqual(foreignKeyErrors, []);
      assert.deepEqual(job, [{ disabled: 1 }]);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("079_RetireIncompletePurgeJobs", (it) => {
  it.effect("quarantines incomplete jobs without changing their manifests", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });
      yield* sql`
        INSERT INTO purge_jobs (
          job_id, entity_kind, entity_id, phase, status, resource_manifest_json,
          last_error, execution_lease_id, execution_lease_expires_at, created_at, updated_at
        ) VALUES
          ('pending-job', 'thread', 'thread-pending', 'files', 'pending', '[{"kind":"attachment"}]',
            NULL, 'pending-lease', '2026-08-18T01:00:00.000Z', 'now', 'now'),
          ('running-job', 'thread', 'thread-running', 'files', 'running', '[{"kind":"provider-log"}]',
            NULL, 'running-lease', '2026-08-18T01:00:00.000Z', 'now', 'now'),
          ('completed-job', 'thread', 'thread-completed', 'root', 'completed', '[]',
            NULL, 'completed-lease', '2026-08-18T01:00:00.000Z', 'now', 'now')
      `;

      yield* runMigrations();

      const jobs = yield* sql`
        SELECT job_id AS "jobId", status, last_error AS "lastError",
          auto_resume_disabled AS "autoResumeDisabled", resource_manifest_json AS "resourceManifest",
          execution_lease_id AS "leaseId", execution_lease_expires_at AS "leaseExpiresAt"
        FROM purge_jobs
        ORDER BY job_id
      `;
      assert.deepEqual(jobs, [
        {
          jobId: "completed-job",
          status: "completed",
          lastError: null,
          autoResumeDisabled: 0,
          resourceManifest: "[]",
          leaseId: "completed-lease",
          leaseExpiresAt: "2026-08-18T01:00:00.000Z",
        },
        {
          jobId: "pending-job",
          status: "failed",
          lastError: "manual_recovery_required",
          autoResumeDisabled: 1,
          resourceManifest: '[{"kind":"attachment"}]',
          leaseId: null,
          leaseExpiresAt: null,
        },
        {
          jobId: "running-job",
          status: "failed",
          lastError: "manual_recovery_required",
          autoResumeDisabled: 1,
          resourceManifest: '[{"kind":"provider-log"}]',
          leaseId: null,
          leaseExpiresAt: null,
        },
      ]);
    }),
  );
});

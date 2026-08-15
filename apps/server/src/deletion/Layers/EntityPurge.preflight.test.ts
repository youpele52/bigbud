import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EntityPurge } from "../Services/EntityPurge.ts";
import { EntityPurgeLive } from "./EntityPurge.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../startup/config.ts";
import type { PurgeJob } from "../../persistence/Services/PurgeJobRepository.ts";

const preflightSequences: Array<number> = [];
let activePreflights = 0;
let maxActivePreflights = 0;
const testLayer = EntityPurgeLive.pipe(
  Layer.provideMerge(
    Layer.succeed(OrchestrationProjectionPipeline, {
      bootstrap: Effect.void,
      backfillUsageContributions: Effect.void,
      ensureVerifiedBaselineThrough: (sequence) =>
        Effect.gen(function* () {
          preflightSequences.push(sequence);
          activePreflights += 1;
          maxActivePreflights = Math.max(maxActivePreflights, activePreflights);
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
          activePreflights -= 1;
        }),
      compactVerifiedPrefix: () => Effect.void,
      projectEvent: () => Effect.void,
    }),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-purge-preflight-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer)("entity purge baseline preflight", (it) => {
  it.effect("preflights the highest deletion sequence once for the batch", () =>
    Effect.gen(function* () {
      preflightSequences.length = 0;
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-03T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('preflight-project', 'Project', NULL, '{}', ${now}, ${now})
      `;
      const jobs: Array<PurgeJob> = [];
      for (const [threadId, sequence] of [
        ["preflight-thread-1", 1],
        ["preflight-thread-2", 7],
      ] as const) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, created_at, updated_at,
            deleted_at, deleting_at, pinned_at
          ) VALUES (
            ${threadId}, 'preflight-project', 'Thread', '{"provider":"codex","model":"test"}',
            'full-access', 'default', NULL, NULL, ${now}, ${now}, ${now}, NULL, NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_baselines (
            sequence, format_version, payload_json, payload_hash, verification_status,
            verification_detail, created_at, verified_at
          ) VALUES (${sequence}, 1, '{}', 'test', 'verified', NULL, ${now}, ${now})
        `;
        yield* sql`
          INSERT INTO orchestration_deletion_markers (
            entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
          ) VALUES ('thread', ${threadId}, ${sequence}, ${now}, ${sequence})
        `;
        jobs.push(yield* purge.requestThread(ThreadId.makeUnsafe(threadId)));
      }

      yield* purge.runBatch(jobs);
      assert.deepEqual(preflightSequences, [7]);
    }),
  );

  it.effect("skips preflight for empty and missing-marker batches", () =>
    Effect.gen(function* () {
      preflightSequences.length = 0;
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-03T00:30:00.000Z";
      yield* purge.runBatch([]);
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('no-marker-project', 'Project', NULL, '{}', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          'no-marker-thread', 'no-marker-project', 'Thread',
          '{"provider":"codex","model":"test"}', 'full-access', 'default', ${now}, ${now}
        )
      `;
      const job = yield* purge.requestThread(ThreadId.makeUnsafe("no-marker-thread"));
      yield* purge.runBatch([job]);
      assert.deepEqual(preflightSequences, []);
    }),
  );

  it.effect("serializes concurrent explicit purge maintenance", () =>
    Effect.gen(function* () {
      preflightSequences.length = 0;
      activePreflights = 0;
      maxActivePreflights = 0;
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-03T01:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('singleflight-project', 'Project', NULL, '{}', ${now}, ${now})
      `;
      const jobs: Array<PurgeJob> = [];
      for (const [threadId, sequence] of [
        ["singleflight-thread-1", 11],
        ["singleflight-thread-2", 12],
      ] as const) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, created_at, updated_at,
            deleted_at, deleting_at, pinned_at
          ) VALUES (
            ${threadId}, 'singleflight-project', 'Thread', '{"provider":"codex","model":"test"}',
            'full-access', 'default', NULL, NULL, ${now}, ${now}, ${now}, NULL, NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_baselines (
            sequence, format_version, payload_json, payload_hash, verification_status,
            verification_detail, created_at, verified_at
          ) VALUES (${sequence}, 1, '{}', 'test', 'verified', NULL, ${now}, ${now})
        `;
        yield* sql`
          INSERT INTO orchestration_deletion_markers (
            entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
          ) VALUES ('thread', ${threadId}, ${sequence}, ${now}, ${sequence})
        `;
        jobs.push(yield* purge.requestThread(ThreadId.makeUnsafe(threadId)));
      }
      yield* Effect.all(
        jobs.map((job) => purge.run(job)),
        { concurrency: "unbounded" },
      );
      assert.equal(maxActivePreflights, 1);
      assert.deepEqual(
        preflightSequences.toSorted((left, right) => left - right),
        [11, 12],
      );
    }),
  );
  it.effect("discovers a bounded orphan manifest without a project workspace", () =>
    Effect.gen(function* () {
      preflightSequences.length = 0;
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const now = "2026-08-03T02:00:00.000Z";
      yield* sql`DELETE FROM purge_jobs`;
      yield* sql`DELETE FROM orchestration_deletion_markers`;
      for (const [threadId, sequence] of [
        ["orphan-thread-a", 21],
        ["orphan-thread-b", 22],
        ["orphan-thread-c", 23],
      ] as const) {
        yield* sql`
          INSERT INTO projection_baselines (
            sequence, format_version, payload_json, payload_hash, verification_status,
            verification_detail, created_at, verified_at
          ) VALUES (${sequence}, 1, '{}', 'test', 'verified', NULL, ${now}, ${now})
        `;
        yield* sql`
          INSERT INTO orchestration_deletion_markers (
            entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
          ) VALUES ('thread', ${threadId}, ${sequence}, ${now}, ${sequence})
        `;
        yield* fs.writeFileString(`${config.providerLogsDir}/${threadId}.log`, "orphan");
      }
      yield* purge.auditAndResume(2);
      const completed = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM purge_jobs WHERE status = 'completed' AND entity_id LIKE 'orphan-thread-%'
      `;
      assert.deepEqual(completed, [{ count: 2 }]);
      const survivors = yield* Effect.forEach(
        ["orphan-thread-a", "orphan-thread-b", "orphan-thread-c"],
        (threadId) => fs.exists(`${config.providerLogsDir}/${threadId}.log`),
      );
      assert.equal(survivors.filter(Boolean).length, 1);
    }),
  );

  it.effect("requires root proof and persists capped exponential retries", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-03T03:00:00.000Z";
      yield* sql`
        INSERT INTO purge_jobs (
          job_id, entity_kind, entity_id, phase, status, resource_manifest_json,
          attempt_count, last_error, created_at, updated_at, completed_at
        ) VALUES (
          'root-proof-retry', 'thread', 'root-proof-thread', 'root', 'pending', '[]',
          0, NULL, ${now}, ${now}, NULL
        )
      `;
      yield* sql`
        INSERT INTO purge_checkpoint_ref_sets (
          job_id, workspace_cwd, captured_at, repository_kind, verified_at
        ) VALUES ('root-proof-retry', '/tmp/root-proof-thread', ${now}, 'non-git', ${now})
      `;

      yield* purge.auditAndResume();
      const first = yield* sql<{ attemptCount: number; updatedAt: string }>`
        SELECT attempt_count AS "attemptCount", updated_at AS "updatedAt"
        FROM purge_jobs WHERE job_id = 'root-proof-retry'
      `;
      assert.equal(first[0]?.attemptCount, 1);
      const firstDelay = Date.parse(first[0]!.updatedAt) - Date.now();
      assert.isAtLeast(firstDelay, 14 * 60 * 1_000);
      assert.isAtMost(firstDelay, 15 * 60 * 1_000);

      yield* purge.auditAndResume();
      const notDue = yield* sql<{ attemptCount: number }>`
        SELECT attempt_count AS "attemptCount" FROM purge_jobs
        WHERE job_id = 'root-proof-retry'
      `;
      assert.equal(notDue[0]?.attemptCount, 1);

      yield* sql`
        INSERT INTO orchestration_deletion_markers (
          entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
        ) VALUES ('thread', 'root-proof-thread', 31, ${now}, NULL)
      `;
      for (let expectedAttempt = 2; expectedAttempt <= 5; expectedAttempt += 1) {
        yield* sql`
          UPDATE purge_jobs SET updated_at = '2000-01-01T00:00:00.000Z'
          WHERE job_id = 'root-proof-retry'
        `;
        yield* purge.auditAndResume();
        const rows = yield* sql<{ attemptCount: number; updatedAt: string }>`
          SELECT attempt_count AS "attemptCount", updated_at AS "updatedAt"
          FROM purge_jobs WHERE job_id = 'root-proof-retry'
        `;
        assert.equal(rows[0]?.attemptCount, expectedAttempt);
        const expectedDelay = Math.min(24 * 60, 15 * 2 ** (expectedAttempt - 1)) * 60 * 1_000;
        const delay = Date.parse(rows[0]!.updatedAt) - Date.now();
        assert.isAtLeast(delay, expectedDelay - 1_000);
        assert.isAtMost(delay, expectedDelay);
      }
      yield* sql`
        UPDATE purge_jobs SET updated_at = '2000-01-01T00:00:00.000Z'
        WHERE job_id = 'root-proof-retry'
      `;
      yield* purge.auditAndResume();
      const exhausted = yield* sql<{ attemptCount: number }>`
        SELECT attempt_count AS "attemptCount" FROM purge_jobs
        WHERE job_id = 'root-proof-retry'
      `;
      assert.equal(exhausted[0]?.attemptCount, 5);

      const canonical = yield* sql<{ sequence: number }>`
        SELECT COALESCE(MAX(sequence), 31) AS sequence FROM orchestration_events
      `;
      const proofSequence = Math.max(31, canonical[0]?.sequence ?? 31) + 1_000;
      yield* sql`
        INSERT INTO projection_baselines (
          sequence, format_version, payload_json, payload_hash, verification_status,
          verification_detail, created_at, verified_at
        ) VALUES (${proofSequence}, 1, '{}', 'test', 'verified', NULL, ${now}, ${now})
        ON CONFLICT (sequence) DO NOTHING
      `;
      yield* sql`
        UPDATE orchestration_deletion_markers SET covered_by_baseline_sequence = ${proofSequence}
        WHERE entity_kind = 'thread' AND entity_id = 'root-proof-thread'
      `;
      yield* sql`
        UPDATE purge_jobs SET updated_at = '2000-01-01T00:00:00.000Z'
        WHERE job_id = 'root-proof-retry'
      `;
      yield* purge.auditAndResume();
      const completed = yield* sql<{ status: string; lastError: string | null }>`
        SELECT status, last_error AS "lastError" FROM purge_jobs WHERE job_id = 'root-proof-retry'
      `;
      assert.deepEqual(completed, [{ status: "completed", lastError: null }]);
    }),
  );

  it.effect("quarantines a purge job when its deletion marker never appears", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const job = yield* purge.requestThread(ThreadId.makeUnsafe("missing-marker-thread"));

      for (let attempt = 0; attempt < 5; attempt += 1) {
        yield* sql`
          UPDATE purge_jobs SET updated_at = '2000-01-01T00:00:00.000Z'
          WHERE job_id = ${job.jobId}
        `;
        yield* purge.auditAndResume();
      }

      const stored = yield* sql<{
        autoResumeDisabled: number;
        lastError: string | null;
      }>`
        SELECT auto_resume_disabled AS "autoResumeDisabled", last_error AS "lastError"
        FROM purge_jobs WHERE job_id = ${job.jobId}
      `;
      assert.deepEqual(stored, [{ autoResumeDisabled: 1, lastError: "manual_recovery_required" }]);
    }),
  );
});

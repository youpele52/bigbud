import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../startup/config.ts";
import { EntityPurge } from "../Services/EntityPurge.ts";
import { makeEntityPurgeSql } from "./EntityPurge.sql.ts";
import { EntityPurgeLive } from "./EntityPurge.ts";

const NOW = "2026-08-04T00:00:00.000Z";
const GitCoreTestLayer = GitCoreLive;
const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(Layer.provide(GitCoreTestLayer));
const testLayer = EntityPurgeLive.pipe(
  Layer.provideMerge(
    Layer.succeed(OrchestrationProjectionPipeline, {
      bootstrap: Effect.void,
      backfillUsageContributions: Effect.void,
      ensureVerifiedBaselineThrough: () => Effect.void,
      compactVerifiedPrefix: () => Effect.void,
      projectEvent: () => Effect.void,
    }),
  ),
  Layer.provideMerge(GitCoreTestLayer),
  Layer.provideMerge(CheckpointStoreTestLayer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-purge-runtime-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const seedDeletableThread = Effect.fn("seedDeletableRuntimeThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly worktreePath: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const projectId = ProjectId.makeUnsafe(`project-${input.threadId}`);
  yield* sql`
    INSERT INTO projection_projects (project_id, title, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Project', '{}', ${NOW}, ${NOW})
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, worktree_path, created_at, updated_at
    ) VALUES (
      ${input.threadId}, ${projectId}, 'Thread', '{"provider":"codex","model":"test"}',
      'full-access', 'default', ${input.worktreePath}, ${NOW}, ${NOW}
    )
  `;
  yield* sql`
    INSERT INTO projection_baselines (
      sequence, format_version, payload_json, payload_hash, verification_status,
      verification_detail, created_at, verified_at
    ) VALUES (1, 1, '{}', 'test', 'verified', NULL, ${NOW}, ${NOW})
    ON CONFLICT (sequence) DO NOTHING
  `;
});

const seedCoveredDeletion = Effect.fn("seedCoveredRuntimeDeletion")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_deletion_markers (
      entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
    ) VALUES ('thread', ${threadId}, 1, ${NOW}, 1)
  `;
});

const initializeCheckpointRepository = Effect.fn("initializeCheckpointRepository")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* GitCore;
  yield* git.initRepo({ cwd });
  yield* fs.writeFileString(`${cwd}/checkpoint.txt`, "checkpoint");
});

const insertActiveProviderRuntime = Effect.fn("insertActiveProviderRuntime")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO provider_session_runtime (
      thread_id, provider_name, adapter_key, execution_target_id, runtime_mode,
      status, last_seen_at, resume_cursor_json, runtime_payload_json
    ) VALUES (
      ${threadId}, 'codex', 'codex', 'local', 'full-access',
      'running', ${NOW}, NULL, NULL
    )
  `;
});

it.layer(testLayer)("EntityPurge runtime quiescence", (it) => {
  it.effect("fails before destructive work when durable runtime state already exists", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const threadId = ThreadId.makeUnsafe("runtime-before-purge");
      const worktreePath = `${config.worktreesDir}/runtime-before-purge`;
      yield* fs.makeDirectory(worktreePath);
      yield* seedDeletableThread({ threadId, worktreePath });
      const job = yield* purge.requestThread(threadId);
      yield* sql`DROP TRIGGER IF EXISTS thread_retention_guard_provider_runtime_insert`;
      yield* insertActiveProviderRuntime(threadId);

      assert.equal((yield* Effect.exit(purge.run(job)))._tag, "Failure");
      assert.isTrue(yield* fs.exists(worktreePath));
      assert.deepEqual(
        yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id = ${threadId}`,
        [{ thread_id: threadId }],
      );
      yield* sql`DELETE FROM purge_resource_claims WHERE entity_id = ${threadId}`;
    }),
  );

  it.effect("rolls back database cleanup when runtime state appears during it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const threadId = ThreadId.makeUnsafe("runtime-during-purge");
      const worktreePath = `${config.worktreesDir}/runtime-during-purge`;
      yield* fs.makeDirectory(worktreePath);
      yield* seedDeletableThread({ threadId, worktreePath });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('runtime-race-message', ${threadId}, 'user', 'retain', 0, ${NOW}, ${NOW})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, parent_thread_id, created_at, updated_at
        ) VALUES (
          ${`${threadId}-child`}, ${`project-${threadId}`}, 'Child',
          '{"provider":"codex","model":"test"}', 'full-access', 'default',
          ${threadId}, ${NOW}, ${NOW}
        )
      `;
      yield* sql`DROP TRIGGER IF EXISTS thread_retention_guard_provider_runtime_insert`;
      yield* sql.unsafe(`
        CREATE TRIGGER runtime_appears_during_cleanup
        BEFORE UPDATE ON projection_threads
        WHEN OLD.parent_thread_id = '${threadId}'
        BEGIN
          INSERT INTO provider_session_runtime (
            thread_id, provider_name, adapter_key, execution_target_id, runtime_mode,
            status, last_seen_at, resume_cursor_json, runtime_payload_json
          ) VALUES (
            '${threadId}', 'codex', 'codex', 'local', 'full-access',
            'running', '${NOW}', NULL, NULL
          );
        END
      `);

      const queries = makeEntityPurgeSql(sql);
      assert.equal(
        (yield* Effect.exit(queries.deleteThreadDependents({ threadId })))._tag,
        "Failure",
      );
      assert.isTrue(yield* fs.exists(worktreePath));
      assert.deepEqual(
        yield* sql`SELECT message_id FROM projection_thread_messages WHERE thread_id = ${threadId}`,
        [{ message_id: "runtime-race-message" }],
      );
      assert.deepEqual(
        yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id = ${threadId}`,
        [{ thread_id: threadId }],
      );
    }),
  );

  it.effect("retains checkpoints, files, and the thread when runtime appears before files", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const checkpointStore = yield* CheckpointStore;
      const config = yield* ServerConfig;
      const threadId = ThreadId.makeUnsafe("runtime-before-files");
      const worktreePath = `${config.worktreesDir}/runtime-before-files`;
      yield* fs.makeDirectory(worktreePath);
      yield* initializeCheckpointRepository(worktreePath);
      const checkpointRef = checkpointRefForThreadTurn(threadId, 0);
      yield* checkpointStore.captureCheckpoint({ cwd: worktreePath, checkpointRef });
      yield* seedDeletableThread({ threadId, worktreePath });
      yield* seedCoveredDeletion(threadId);
      const job = yield* purge.requestThread(threadId);
      yield* sql`DROP TRIGGER IF EXISTS thread_retention_guard_provider_runtime_insert`;
      yield* sql.unsafe(`
        CREATE TRIGGER runtime_appears_before_files
        BEFORE UPDATE ON purge_jobs
        WHEN OLD.job_id = '${job.jobId}' AND NEW.phase = 'files'
        BEGIN
          INSERT INTO provider_session_runtime (
            thread_id, provider_name, adapter_key, execution_target_id, runtime_mode,
            status, last_seen_at, resume_cursor_json, runtime_payload_json
          ) VALUES (
            '${threadId}', 'codex', 'codex', 'local', 'full-access',
            'running', '${NOW}', NULL, NULL
          );
        END
      `);

      assert.equal((yield* Effect.exit(purge.run(job)))._tag, "Failure");
      assert.isTrue(yield* checkpointStore.hasCheckpointRef({ cwd: worktreePath, checkpointRef }));
      assert.isTrue(yield* fs.exists(worktreePath));
      assert.deepEqual(
        yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id = ${threadId}`,
        [{ thread_id: threadId }],
      );
      const purgeStatus = yield* sql<{ readonly status: string }>`
        SELECT status FROM purge_jobs WHERE job_id = ${job.jobId}
      `;
      assert.notEqual(purgeStatus[0]?.status, "completed");
      assert.deepEqual(
        yield* sql<{
          readonly status: string;
        }>`SELECT status FROM provider_session_runtime WHERE thread_id = ${threadId}`,
        [{ status: "running" }],
      );
      yield* sql`DELETE FROM purge_resource_claims WHERE entity_id = ${threadId}`;
    }),
  );

  it.effect("retains the thread root when runtime appears at the root boundary", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const threadId = ThreadId.makeUnsafe("runtime-before-root");
      const worktreePath = `${config.worktreesDir}/runtime-before-root`;
      yield* fs.makeDirectory(worktreePath);
      yield* seedDeletableThread({ threadId, worktreePath });
      yield* seedCoveredDeletion(threadId);
      const job = yield* purge.requestThread(threadId);
      yield* sql`DROP TRIGGER IF EXISTS thread_retention_guard_provider_runtime_insert`;
      yield* sql.unsafe(`
        CREATE TRIGGER runtime_appears_before_root
        BEFORE UPDATE ON purge_jobs
        WHEN OLD.job_id = '${job.jobId}' AND NEW.phase = 'root'
        BEGIN
          INSERT INTO provider_session_runtime (
            thread_id, provider_name, adapter_key, execution_target_id, runtime_mode,
            status, last_seen_at, resume_cursor_json, runtime_payload_json
          ) VALUES (
            '${threadId}', 'codex', 'codex', 'local', 'full-access',
            'running', '${NOW}', NULL, NULL
          );
        END
      `);

      assert.equal((yield* Effect.exit(purge.run(job)))._tag, "Failure");
      assert.deepEqual(
        yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id = ${threadId}`,
        [{ thread_id: threadId }],
      );
      const purgeStatus = yield* sql<{ readonly status: string }>`
        SELECT status FROM purge_jobs WHERE job_id = ${job.jobId}
      `;
      assert.notEqual(purgeStatus[0]?.status, "completed");
      assert.deepEqual(
        yield* sql<{
          readonly status: string;
        }>`SELECT status FROM provider_session_runtime WHERE thread_id = ${threadId}`,
        [{ status: "running" }],
      );
    }),
  );
});

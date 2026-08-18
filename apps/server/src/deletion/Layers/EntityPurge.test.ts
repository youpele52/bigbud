import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EntityPurge } from "../Services/EntityPurge.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../startup/config.ts";
import { EntityPurgeLive } from "./EntityPurge.ts";

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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-entity-purge-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const seedProjectAndThread = Effect.fn("seedProjectAndThread")(function* (input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly deletedAt?: string | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  const now = "2026-07-30T00:00:00.000Z";
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json,
      created_at, updated_at, deleted_at, deleting_at
    ) VALUES (
      ${input.projectId}, 'Project', ${input.workspaceRoot}, '{}',
      ${now}, ${now}, NULL, NULL
    )
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, branch, worktree_path, created_at, updated_at, deleted_at, deleting_at,
      pinned_at
    ) VALUES (
      ${input.threadId}, ${input.projectId}, 'Thread', '{"provider":"codex","model":"gpt-5.6"}', 'full-access',
      'default', NULL, ${input.worktreePath}, ${now}, ${now}, ${input.deletedAt ?? null}, NULL, ${now}
    )
  `;
});

const seedCoveredDeletion = Effect.fn("seedCoveredDeletion")(function* (input: {
  readonly entityKind: "project" | "thread";
  readonly entityId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const now = "2026-07-30T00:00:00.000Z";
  yield* sql`
    INSERT INTO projection_baselines (
      sequence, format_version, payload_json, payload_hash, verification_status,
      verification_detail, created_at, verified_at
    ) VALUES (1, 1, '{}', 'test', 'verified', NULL, ${now}, ${now})
    ON CONFLICT (sequence) DO NOTHING
  `;
  yield* sql`
    INSERT INTO orchestration_deletion_markers (
      entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
    ) VALUES (${input.entityKind}, ${input.entityId}, 1, ${now}, 1)
  `;
});

it.layer(testLayer)("EntityPurge", (it) => {
  it.effect("hard-deletes thread rows and only explicitly owned managed files", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const projectId = ProjectId.makeUnsafe("project-thread-purge");
      const threadId = ThreadId.makeUnsafe("thread-purge");
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "user-workspace-" });
      const workspaceSentinel = `${workspaceRoot}/keep.txt`;
      const worktreePath = `${config.worktreesDir}/thread-purge`;
      const attachmentPath = `${config.attachmentsDir}/thread-purge-00000000-0000-0000-0000-000000000001.png`;
      yield* fs.writeFileString(workspaceSentinel, "keep");
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      yield* fs.writeFileString(`${worktreePath}/managed.txt`, "delete");
      yield* fs.writeFileString(attachmentPath, "delete");
      yield* seedProjectAndThread({
        projectId,
        threadId,
        workspaceRoot,
        worktreePath,
      });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at, attachments_json
        ) VALUES (
          'message-purge', ${threadId}, 'user', 'delete', 0,
          '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z',
          '[{"type":"image","id":"thread-purge-00000000-0000-0000-0000-000000000001","name":"delete.png","mimeType":"image/png","sizeBytes":6}]'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'activity-purge', ${threadId}, 'info', 'test', 'delete', '{}',
          '2026-07-30T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_tasks (task_id, thread_id, task_json, created_at, updated_at)
        VALUES ('task-purge', ${threadId}, '{}', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_pending_user_inputs (
          request_id, thread_id, status, questions_json, created_at
        ) VALUES ('input-purge', ${threadId}, 'pending', '[]', '2026-07-30T00:00:00.000Z')
      `;
      yield* seedCoveredDeletion({ entityKind: "thread", entityId: threadId });

      const job = yield* purge.requestThread(threadId);
      yield* purge.run(job);

      const rows = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(rows, [{ count: 0 }]);
      const pendingUserInputs = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM projection_pending_user_inputs WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(pendingUserInputs, [{ count: 0 }]);
      assert.isFalse(yield* fs.exists(attachmentPath));
      assert.isFalse(yield* fs.exists(worktreePath));
      assert.isTrue(yield* fs.exists(workspaceSentinel));
    }),
  );

  it.effect("purges pinned project threads without removing the project workspace", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const projectId = ProjectId.makeUnsafe("project-legacy-purge");
      const threadId = ThreadId.makeUnsafe("thread-legacy-purge");
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-workspace-" });
      const workspaceSentinel = `${workspaceRoot}/keep.txt`;
      yield* fs.writeFileString(workspaceSentinel, "keep");
      yield* seedProjectAndThread({
        projectId,
        threadId,
        workspaceRoot,
        worktreePath: null,
        deletedAt: "2026-07-30T00:00:00.000Z",
      });
      yield* seedCoveredDeletion({ entityKind: "project", entityId: projectId });
      yield* seedCoveredDeletion({ entityKind: "thread", entityId: threadId });
      const pinned = yield* sql<{ readonly pinnedAt: string | null }>`
        SELECT pinned_at AS "pinnedAt" FROM projection_threads WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(pinned, [{ pinnedAt: "2026-07-30T00:00:00.000Z" }]);
      yield* sql`
        UPDATE projection_projects
        SET deleted_at = '2026-07-30T00:00:00.000Z'
        WHERE project_id = ${projectId}
      `;
      const projectDirectories = [
        `${config.stateDir}/memory/projects/${projectId}`,
        `${config.notesDir}/${projectId}`,
        `${config.kanbanDir}/${projectId}`,
      ];
      for (const directory of projectDirectories) {
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(`${directory}/delete.txt`, "delete");
      }

      yield* purge.auditAndResume();

      const projects = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM projection_projects WHERE project_id = ${projectId}
      `;
      const threads = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(projects, [{ count: 0 }]);
      assert.deepStrictEqual(threads, [{ count: 0 }]);
      for (const directory of projectDirectories) {
        assert.isFalse(yield* fs.exists(directory));
      }
      assert.isTrue(yield* fs.exists(workspaceSentinel));
    }),
  );

  it.effect("keeps paths outside managed roots when a persisted manifest contains traversal", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const outsidePath = `${config.stateDir}/outside-managed-root.txt`;
      yield* fs.writeFileString(outsidePath, "keep");
      yield* sql`
        INSERT INTO purge_jobs (
          job_id, entity_kind, entity_id, phase, status, resource_manifest_json,
          attempt_count, last_error, created_at, updated_at, completed_at
        ) VALUES (
          'purge-traversal', 'thread', 'thread-traversal', 'awaiting-finalization', 'pending',
          '[{"kind":"managed-worktree","relativePath":"../outside-managed-root.txt"}]',
          0, NULL, '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z', NULL
        )
      `;

      const result = yield* Effect.exit(purge.auditAndResume());

      assert.equal(result._tag, "Success");
      assert.isTrue(yield* fs.exists(outsidePath));
      const failedJobs = yield* sql<{ status: string }>`
        SELECT status FROM purge_jobs WHERE job_id = 'purge-traversal'
      `;
      assert.deepEqual(failedJobs, [{ status: "pending" }]);
      yield* sql`DELETE FROM purge_jobs WHERE job_id = 'purge-traversal'`;
    }),
  );

  it.effect("resumes a persisted pinned-thread deletion job", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("project-resume-purge");
      const threadId = ThreadId.makeUnsafe("thread-resume-purge");
      yield* seedProjectAndThread({
        projectId,
        threadId,
        workspaceRoot: "/tmp/project-resume-purge",
        worktreePath: null,
      });
      yield* seedCoveredDeletion({ entityKind: "thread", entityId: threadId });
      const pinned = yield* sql<{ readonly pinnedAt: string | null }>`
        SELECT pinned_at AS "pinnedAt" FROM projection_threads WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(pinned, [{ pinnedAt: "2026-07-30T00:00:00.000Z" }]);
      const job = yield* purge.requestThread(threadId);
      yield* sql`
        UPDATE purge_jobs
        SET phase = 'database', status = 'failed', last_error = 'simulated restart',
          updated_at = '2026-07-30T00:00:01.000Z'
        WHERE job_id = ${job.jobId}
      `;

      yield* purge.auditAndResume();

      const rows = yield* sql<{ readonly threadCount: number; readonly completedJobCount: number }>`
        SELECT
          (SELECT COUNT(*) FROM projection_threads WHERE thread_id = ${threadId}) AS "threadCount",
          (SELECT COUNT(*) FROM purge_jobs WHERE job_id = ${job.jobId} AND status = 'completed') AS "completedJobCount"
      `;
      assert.deepEqual(rows, [{ threadCount: 0, completedJobCount: 1 }]);
    }),
  );

  it.effect("removes bounded orphan projection rows", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = OFF`;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'orphan-message', 'missing-thread', 'user', 'delete', 0,
          '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
        )
      `;
      yield* sql`PRAGMA foreign_keys = ON`;

      yield* purge.auditAndResume(10);

      const rows = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_thread_messages
        WHERE thread_id = 'missing-thread'
      `;
      assert.deepStrictEqual(rows, [{ count: 0 }]);
    }),
  );

  it.effect("retains canonical data until a content-free deletion marker is baseline-covered", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("project-proof-purge");
      const threadId = ThreadId.makeUnsafe("thread-proof-purge");
      const now = "2026-07-30T00:00:00.000Z";
      yield* seedProjectAndThread({
        projectId,
        threadId,
        workspaceRoot: "/tmp/project-proof-purge",
        worktreePath: null,
      });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES ('event-proof-purge', 'thread', ${threadId}, 0, 'thread.deleted', ${now},
          'command-proof-purge', NULL, NULL, 'server', '{}', '{}')
      `;
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
        ) VALUES ('command-proof-purge', 'thread', ${threadId}, ${now}, 1, 'accepted', NULL)
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('proof-message', ${threadId}, 'user', 'retain', 0, ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO orchestration_deletion_markers (
          entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
        ) VALUES ('thread', ${threadId}, 1, ${now}, NULL)
      `;

      const job = yield* purge.requestThread(threadId);
      const blocked = yield* Effect.exit(purge.run(job));
      assert.equal(blocked._tag, "Failure");
      const retained = yield* sql<{ readonly events: number; readonly receipts: number }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = ${threadId}) AS events,
          (SELECT COUNT(*) FROM orchestration_command_receipts WHERE aggregate_id = ${threadId}) AS receipts
      `;
      assert.deepEqual(retained, [{ events: 1, receipts: 1 }]);
      assert.deepEqual(
        yield* sql`SELECT message_id FROM projection_thread_messages WHERE thread_id = ${threadId}`,
        [{ message_id: "proof-message" }],
      );

      yield* sql`
        UPDATE orchestration_deletion_markers SET covered_by_baseline_sequence = 1
        WHERE entity_kind = 'thread' AND entity_id = ${threadId}
      `;
      yield* sql`
        INSERT INTO projection_baselines (
          sequence, format_version, payload_json, payload_hash, verification_status,
          verification_detail, created_at, verified_at
        ) VALUES (1, 1, '{}', 'test', 'verified', NULL, ${now}, ${now})
        ON CONFLICT (sequence) DO NOTHING
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES ('event-after-proof', 'thread', ${threadId}, 1, 'thread.meta-updated', ${now},
          NULL, NULL, NULL, 'server', '{}', '{}')
      `;
      yield* sql`
        UPDATE purge_jobs SET updated_at = '2000-01-01T00:00:00.000Z'
        WHERE job_id = ${job.jobId}
      `;
      const staleProof = yield* Effect.exit(purge.run(job));
      assert.equal(staleProof._tag, "Failure");
      yield* sql`DELETE FROM orchestration_events WHERE event_id = 'event-after-proof'`;
      yield* sql`
        UPDATE purge_jobs SET updated_at = '2000-01-01T00:00:00.000Z'
        WHERE job_id = ${job.jobId}
      `;
      yield* purge.run(job);
      const finalized = yield* sql<{
        readonly events: number;
        readonly eventIds: number;
        readonly identities: number;
        readonly streams: number;
        readonly receipts: number;
        readonly markers: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = ${threadId}) AS events,
          (SELECT COUNT(*) FROM orchestration_event_ids WHERE sequence = 1) AS "eventIds",
          (SELECT COUNT(*) FROM orchestration_thread_identity WHERE thread_id = ${threadId}) AS identities,
          (SELECT COUNT(*) FROM orchestration_stream_state
            WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}) AS streams,
          (SELECT COUNT(*) FROM orchestration_command_receipts WHERE aggregate_id = ${threadId}) AS receipts,
          (SELECT COUNT(*) FROM orchestration_deletion_markers WHERE entity_id = ${threadId}) AS markers
      `;
      assert.deepEqual(finalized, [
        { events: 0, eventIds: 0, identities: 0, streams: 0, receipts: 0, markers: 0 },
      ]);
    }),
  );
});

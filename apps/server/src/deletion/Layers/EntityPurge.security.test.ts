import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../startup/config.ts";
import { EntityPurge } from "../Services/EntityPurge.ts";
import { EntityPurgeLive } from "./EntityPurge.ts";
import { captureResourceIdentity, deleteResourceAtomically } from "./EntityPurge.resources.ts";

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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-purge-security-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const NOW = "2026-08-04T00:00:00.000Z";

const seedThread = Effect.fn("seedSecurityThread")(function* (input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly worktreePath?: string | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (${input.projectId}, 'Project', NULL, '{}', ${NOW}, ${NOW})
    ON CONFLICT (project_id) DO NOTHING
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, branch, worktree_path, created_at, updated_at,
      deleted_at, deleting_at, pinned_at
    ) VALUES (
      ${input.threadId}, ${input.projectId}, 'Thread', '{"provider":"codex","model":"test"}',
      'full-access', 'default', NULL, ${input.worktreePath ?? null}, ${NOW}, ${NOW}, NULL, NULL, NULL
    )
  `;
});

const seedMarker = Effect.fn("seedSecurityMarker")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_baselines (
      sequence, format_version, payload_json, payload_hash, verification_status,
      verification_detail, created_at, verified_at
    ) VALUES (1, 1, '{}', 'test', 'verified', NULL, ${NOW}, ${NOW})
    ON CONFLICT (sequence) DO NOTHING
  `;
  yield* sql`
    INSERT INTO orchestration_deletion_markers (
      entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
    ) VALUES ('thread', ${threadId}, 1, ${NOW}, 1)
  `;
});

function attachmentJson(id: string): string {
  return JSON.stringify([
    {
      type: "image",
      id,
      name: "capture.png",
      mimeType: "image/png",
      sizeBytes: 7,
    },
  ]);
}

it.layer(testLayer)("EntityPurge resource safety", (it) => {
  it.effect("keeps an attachment referenced by a retained thread", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const projectId = ProjectId.makeUnsafe("security-shared-attachment");
      const deletingId = ThreadId.makeUnsafe("security-deleting-attachment");
      const retainedId = ThreadId.makeUnsafe("security-retained-attachment");
      const attachmentId = "security-shared-00000000-0000-4000-8000-000000000001";
      const attachmentPath = `${config.attachmentsDir}/${attachmentId}.png`;
      yield* fs.writeFileString(attachmentPath, "keep-me");
      yield* seedThread({ projectId, threadId: deletingId });
      yield* seedThread({ projectId, threadId: retainedId });
      for (const [messageId, threadId] of [
        ["deleting-message", deletingId],
        ["retained-message", retainedId],
      ] as const) {
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, role, text, is_streaming, created_at, updated_at, attachments_json
          ) VALUES (${messageId}, ${threadId}, 'user', 'shared', 0, ${NOW}, ${NOW}, ${attachmentJson(attachmentId)})
        `;
      }
      yield* seedMarker(deletingId);
      const deletingJob = yield* purge.requestThread(deletingId);
      yield* purge.run(deletingJob);
      assert.isTrue(yield* fs.exists(attachmentPath));
      const retained = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id = ${retainedId}`;
      assert.deepEqual(retained, [{ count: 1 }]);
      yield* seedMarker(retainedId);
      const finalJob = yield* purge.requestThread(retainedId);
      yield* purge.run(finalJob);
      assert.isFalse(yield* fs.exists(attachmentPath));
    }),
  );

  it.effect("captures and deletes generated computer-use screenshot attachments", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const projectId = ProjectId.makeUnsafe("security-activity-attachment");
      const threadId = ThreadId.makeUnsafe("security-activity-thread");
      const attachmentId = "security-activity-00000000-0000-4000-8000-000000000001";
      const attachmentPath = `${config.attachmentsDir}/${attachmentId}.png`;
      yield* fs.writeFileString(attachmentPath, "delete");
      yield* seedThread({ projectId, threadId });
      const payload = JSON.stringify({
        title: "computer_use",
        data: { result: { screenshot: { attachmentId, mimeType: "image/png" } } },
      });
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES ('security-activity', ${threadId}, 'tool', 'tool.completed', 'Captured', ${payload}, ${NOW})
      `;
      yield* seedMarker(threadId);
      const job = yield* purge.requestThread(threadId);
      yield* purge.run(job);
      assert.isFalse(yield* fs.exists(attachmentPath));
    }),
  );

  it.effect("rejects shared managed worktrees before creating a purge job", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const projectId = ProjectId.makeUnsafe("security-shared-worktree");
      const firstId = ThreadId.makeUnsafe("security-worktree-first");
      const secondId = ThreadId.makeUnsafe("security-worktree-second");
      const worktreePath = `${config.worktreesDir}/shared-worktree`;
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      yield* fs.writeFileString(`${worktreePath}/keep.txt`, "keep");
      yield* seedThread({ projectId, threadId: firstId, worktreePath });
      yield* seedThread({ projectId, threadId: secondId, worktreePath });
      assert.equal((yield* Effect.exit(purge.requestThread(firstId)))._tag, "Failure");
      assert.isTrue(yield* fs.exists(`${worktreePath}/keep.txt`));
    }),
  );

  it.effect("rejects symlink worktrees and preserves their external target", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const projectId = ProjectId.makeUnsafe("security-symlink-worktree");
      const threadId = ThreadId.makeUnsafe("security-symlink-thread");
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "outside-worktree-" });
      const sentinel = `${outside}/keep.txt`;
      const worktreePath = `${config.worktreesDir}/symlink-worktree`;
      yield* fs.writeFileString(sentinel, "keep");
      yield* fs.symlink(outside, worktreePath);
      yield* seedThread({ projectId, threadId, worktreePath });
      assert.equal((yield* Effect.exit(purge.requestThread(threadId)))._tag, "Failure");
      assert.isTrue(yield* fs.exists(sentinel));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
      yield* fs.remove(worktreePath);
    }),
  );

  it.effect("fails closed when a resource identity changes after manifest capture", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const projectId = ProjectId.makeUnsafe("security-identity-change");
      const threadId = ThreadId.makeUnsafe("security-identity-thread");
      const worktreePath = `${config.worktreesDir}/identity-worktree`;
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      yield* fs.writeFileString(`${worktreePath}/old.txt`, "old");
      yield* seedThread({ projectId, threadId, worktreePath });
      yield* seedMarker(threadId);
      const job = yield* purge.requestThread(threadId);
      yield* fs.remove(worktreePath, { recursive: true });
      yield* fs.makeDirectory(worktreePath);
      yield* fs.writeFileString(`${worktreePath}/replacement.txt`, "keep");
      assert.equal((yield* Effect.exit(purge.run(job)))._tag, "Failure");
      assert.isTrue(yield* fs.exists(`${worktreePath}/replacement.txt`));
    }),
  );

  it.effect("rejects lossy provider-log segment collisions", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const projectId = ProjectId.makeUnsafe("security-provider-log");
      const firstId = ThreadId.makeUnsafe("security-log!");
      const secondId = ThreadId.makeUnsafe("security-log@");
      const logPath = `${config.providerLogsDir}/security-log.log`;
      yield* fs.writeFileString(logPath, "keep");
      yield* seedThread({ projectId, threadId: firstId });
      yield* seedThread({ projectId, threadId: secondId });
      assert.equal((yield* Effect.exit(purge.requestThread(firstId)))._tag, "Failure");
      assert.isTrue(yield* fs.exists(logPath));
    }),
  );

  it.effect("deletes and verifies every thread-owned maintenance table", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("security-complete-verification");
      const threadId = ThreadId.makeUnsafe("security-complete-thread");
      yield* seedThread({ projectId, threadId });
      yield* sql`
        INSERT INTO automation_schedules (
          automation_id, project_id, target_thread_id, title, prompt, cron_expression,
          timezone, created_at, updated_at
        ) VALUES ('security-automation', ${projectId}, ${threadId}, 'Schedule', 'Prompt',
          '* * * * *', 'UTC', ${NOW}, ${NOW})
      `;
      yield* sql`
        INSERT INTO automation_runs (
          run_id, automation_id, thread_id, message_id, command_id, status, started_at
        ) VALUES ('security-run', 'security-automation', ${threadId}, 'message', 'command', 'completed', ${NOW})
      `;
      yield* sql`
        INSERT INTO learning_jobs (
          job_id, thread_id, turn_id, provider, model, model_selection_json, state,
          created_at, updated_at
        ) VALUES ('security-learning', ${threadId}, 'turn', 'codex', 'test', '{}', 'completed', ${NOW}, ${NOW})
      `;
      yield* sql`
        INSERT INTO skill_change_proposals (
          proposal_id, thread_id, turn_id, provider, skill_path, original_hash,
          old_text, new_text, reason, status, created_at
        ) VALUES ('security-skill', ${threadId}, 'turn', 'codex', '/tmp/skill', 'hash',
          'old', 'new', 'test', 'pending', ${NOW})
      `;
      yield* sql`
        INSERT INTO orchestration_thread_identity (thread_id, project_id, created_sequence)
        VALUES (${threadId}, ${projectId}, 1)
      `;
      yield* seedMarker(threadId);
      const job = yield* purge.requestThread(threadId);
      yield* purge.run(job);
      const rows = yield* sql<{ count: number }>`
        SELECT (
          (SELECT COUNT(*) FROM automation_runs WHERE thread_id = ${threadId}) +
          (SELECT COUNT(*) FROM automation_schedules WHERE target_thread_id = ${threadId}) +
          (SELECT COUNT(*) FROM learning_jobs WHERE thread_id = ${threadId}) +
          (SELECT COUNT(*) FROM skill_change_proposals WHERE thread_id = ${threadId}) +
          (SELECT COUNT(*) FROM orchestration_thread_identity WHERE thread_id = ${threadId})
        ) AS count
      `;
      assert.deepEqual(rows, [{ count: 0 }]);
    }),
  );
  it.effect("rejects symlink roots and nested symlink ancestors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "purge-outside-" });
      const container = yield* fs.makeTempDirectoryScoped({ prefix: "purge-root-container-" });
      yield* fs.writeFileString(`${outside}/keep.txt`, "keep");
      const rootLink = `${container}/root-link`;
      yield* fs.symlink(outside, rootLink);
      assert.equal(
        (yield* Effect.exit(
          Effect.tryPromise(() =>
            captureResourceIdentity({ root: rootLink, target: `${rootLink}/keep.txt` }),
          ),
        ))._tag,
        "Failure",
      );
      yield* fs.remove(rootLink);

      const managedRoot = `${container}/managed`;
      yield* fs.makeDirectory(managedRoot);
      const nestedLink = `${managedRoot}/nested`;
      yield* fs.symlink(outside, nestedLink);
      assert.equal(
        (yield* Effect.exit(
          Effect.tryPromise(() =>
            captureResourceIdentity({ root: managedRoot, target: `${nestedLink}/keep.txt` }),
          ),
        ))._tag,
        "Failure",
      );
      assert.isTrue(yield* fs.exists(`${outside}/keep.txt`));
    }),
  );

  it.effect("fails closed on a pre-existing quarantine tamper", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "purge-quarantine-" });
      const target = `${root}/asset.txt`;
      const jobId = "quarantine-tamper-job";
      yield* fs.writeFileString(target, "keep");
      const identity = yield* Effect.promise(() => captureResourceIdentity({ root, target }));
      assert.isNotNull(identity);
      const quarantine = `${root}/.bigbud-purge-test-tamper`;
      yield* fs.writeFileString(quarantine, "tamper");
      assert.equal(
        (yield* Effect.exit(
          Effect.tryPromise(() =>
            deleteResourceAtomically({
              jobId,
              resolved: { root, target },
              resource: {
                kind: "attachment",
                relativePath: "asset.txt",
                identity,
                quarantineName: ".bigbud-purge-test-tamper",
                action: "delete",
              },
            }),
          ),
        ))._tag,
        "Failure",
      );
      assert.equal(yield* fs.readFileString(target), "keep");
    }),
  );

  it.effect("retains quarantine when its managed ancestor is swapped before removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const container = yield* fs.makeTempDirectoryScoped({ prefix: "purge-ancestor-swap-" });
      const external = yield* fs.makeTempDirectoryScoped({ prefix: "purge-external-sentinel-" });
      const root = `${container}/managed`;
      const movedRoot = `${container}/managed-moved`;
      const target = `${root}/asset.txt`;
      const sentinel = `${external}/keep.txt`;
      yield* fs.makeDirectory(root);
      yield* fs.writeFileString(target, "delete");
      yield* fs.writeFileString(sentinel, "keep");
      const identity = yield* Effect.promise(() => captureResourceIdentity({ root, target }));
      assert.isNotNull(identity);
      const result = yield* Effect.exit(
        Effect.tryPromise(() =>
          deleteResourceAtomically({
            jobId: "ancestor-swap-job",
            resolved: { root, target },
            resource: {
              kind: "attachment",
              relativePath: "asset.txt",
              identity,
              quarantineName: ".bigbud-purge-ancestor-swap-test",
              action: "delete",
            },
            beforeRemove: async () => {
              await nodeFs.rename(root, movedRoot);
              await nodeFs.symlink(external, root);
            },
          }),
        ),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(yield* fs.readFileString(sentinel), "keep");
      assert.isTrue(yield* fs.exists(`${movedRoot}/.bigbud-purge-ancestor-swap-test`));
      yield* fs.remove(root);
    }),
  );
});
import * as nodeFs from "node:fs/promises";

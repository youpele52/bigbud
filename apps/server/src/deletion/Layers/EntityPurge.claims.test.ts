import * as nodeFs from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { captureWorktreePathIdentity } from "../../retention/worktreeRuntimeLease.ts";
import { ServerConfig } from "../../startup/config.ts";
import { EntityPurge } from "../Services/EntityPurge.ts";
import { EntityPurgeLive } from "./EntityPurge.ts";

const NOW = "2026-08-04T00:00:00.000Z";
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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-purge-claims-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const seedThread = Effect.fn("seedClaimThread")(function* (input: {
  projectId: ProjectId;
  threadId: ThreadId;
  worktreePath?: string | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (project_id, title, scripts_json, created_at, updated_at)
    VALUES (${input.projectId}, 'Project', '{}', ${NOW}, ${NOW})
    ON CONFLICT (project_id) DO NOTHING
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, worktree_path, created_at, updated_at
    ) VALUES (
      ${input.threadId}, ${input.projectId}, 'Thread', '{"provider":"codex","model":"test"}',
      'full-access', 'default', ${input.worktreePath ?? null}, ${NOW}, ${NOW}
    )
  `;
});

function attachmentJson(id: string): string {
  return JSON.stringify([
    { type: "image", id, name: "capture.png", mimeType: "image/png", sizeBytes: 7 },
  ]);
}

const assignWorktree = Effect.fn("assignClaimTestWorktree")(function* (input: {
  readonly threadId: ThreadId;
  readonly worktreePath: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* Effect.promise(() => captureWorktreePathIdentity(input.worktreePath));
  yield* sql`
    UPDATE projection_threads
    SET worktree_path = ${input.worktreePath},
      worktree_canonical_path = ${identity.canonicalPath},
      worktree_device = ${identity.device}, worktree_inode = ${identity.inode}
    WHERE thread_id = ${input.threadId}
  `;
});

it.layer(testLayer)("EntityPurge durable resource claims", (it) => {
  it.effect("rejects an attachment reference inserted after claim acquisition", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const projectId = ProjectId.makeUnsafe("claim-attachment-project");
      const deletingId = ThreadId.makeUnsafe("claim-attachment-deleting");
      const retainedId = ThreadId.makeUnsafe("claim-attachment-retained");
      const attachmentId = "claim-attachment-00000000-0000-4000-8000-000000000001";
      yield* seedThread({ projectId, threadId: deletingId });
      yield* seedThread({ projectId, threadId: retainedId });
      yield* fs.writeFileString(`${config.attachmentsDir}/${attachmentId}.png`, "delete");
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES ('deleting-message', ${deletingId}, 'user', 'asset',
          ${attachmentJson(attachmentId)}, 0, ${NOW}, ${NOW})
      `;
      yield* purge.requestThread(deletingId);
      const insertion = yield* Effect.exit(sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES ('racing-message', ${retainedId}, 'user', 'asset',
          ${attachmentJson(attachmentId)}, 0, ${NOW}, ${NOW})
      `);
      assert.equal(insertion._tag, "Failure");
      const unrelatedInsertion = yield* Effect.exit(sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('racing-unrelated-message', ${deletingId}, 'user', 'late', 0, ${NOW}, ${NOW})
      `);
      assert.equal(unrelatedInsertion._tag, "Failure");
      const activityInsertion = yield* Effect.exit(sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES ('racing-activity', ${retainedId}, 'tool', 'tool.completed', 'screenshot',
          ${JSON.stringify({ branch: { screenshot: { attachmentId, mimeType: "image/png" } } })},
          ${NOW})
      `);
      assert.equal(activityInsertion._tag, "Failure");
      assert.isTrue(yield* fs.exists(`${config.attachmentsDir}/${attachmentId}.png`));
    }),
  );

  it.effect("guards only claimed worktree identities and a claim over a live lease", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const projectId = ProjectId.makeUnsafe("claim-worktree-project");
      const deletingId = ThreadId.makeUnsafe("claim-worktree-deleting");
      const retainedId = ThreadId.makeUnsafe("claim-worktree-retained");
      const worktreePath = `${config.worktreesDir}/claimed-worktree`;
      yield* fs.makeDirectory(worktreePath);
      yield* seedThread({ projectId, threadId: deletingId, worktreePath });
      yield* seedThread({ projectId, threadId: retainedId });
      yield* purge.requestThread(deletingId);
      const unrelatedPath = `${config.worktreesDir}/unrelated-worktree`;
      yield* fs.makeDirectory(unrelatedPath);
      assert.equal(
        (yield* Effect.exit(assignWorktree({ threadId: retainedId, worktreePath: unrelatedPath })))
          ._tag,
        "Success",
      );
      assert.equal(
        (yield* Effect.exit(sql`
          UPDATE projection_threads
          SET worktree_path = '/unknown-worktree', worktree_canonical_path = NULL,
            worktree_device = NULL, worktree_inode = NULL
          WHERE thread_id = ${retainedId}
        `))._tag,
        "Success",
      );
      const traversalAlias = `${worktreePath}/../claimed-worktree`;
      assert.equal(
        (yield* Effect.exit(assignWorktree({ threadId: retainedId, worktreePath: traversalAlias })))
          ._tag,
        "Failure",
      );
      const symlinkAlias = `${config.worktreesDir}/claimed-worktree-alias`;
      yield* Effect.promise(() => nodeFs.symlink(worktreePath, symlinkAlias));
      assert.equal(
        (yield* Effect.exit(assignWorktree({ threadId: retainedId, worktreePath: symlinkAlias })))
          ._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(assignWorktree({ threadId: retainedId, worktreePath })))._tag,
        "Failure",
      );
      const canonical = yield* Effect.promise(() => nodeFs.realpath(worktreePath));
      assert.equal(
        (yield* Effect.exit(assignWorktree({ threadId: retainedId, worktreePath: canonical })))
          ._tag,
        "Failure",
      );
      const claimedStats = yield* Effect.promise(() => nodeFs.lstat(canonical));
      assert.equal(
        (yield* Effect.exit(sql`
          UPDATE projection_threads
          SET worktree_path = '/device-inode-alias', worktree_canonical_path = '/device-inode-alias',
            worktree_device = ${claimedStats.dev}, worktree_inode = ${claimedStats.ino}
          WHERE thread_id = ${retainedId}
        `))._tag,
        "Failure",
      );
      const insertedId = ThreadId.makeUnsafe("claim-worktree-inserted");
      assert.equal(
        (yield* Effect.exit(
          seedThread({ projectId, threadId: insertedId, worktreePath: unrelatedPath }),
        ))._tag,
        "Success",
      );

      const nestedPath = `${worktreePath}/nested`;
      yield* fs.makeDirectory(nestedPath);
      assert.equal(
        (yield* Effect.exit(assignWorktree({ threadId: retainedId, worktreePath: nestedPath })))
          ._tag,
        "Failure",
      );
      const parentPath = config.worktreesDir;
      assert.equal(
        (yield* Effect.exit(assignWorktree({ threadId: retainedId, worktreePath: parentPath })))
          ._tag,
        "Failure",
      );

      const unrelatedStats = yield* Effect.promise(() => nodeFs.lstat(unrelatedPath));
      assert.equal(
        (yield* Effect.exit(sql`
          INSERT INTO worktree_runtime_leases (
            lease_id, thread_id, runtime_kind, canonical_path, device, inode, acquired_at, updated_at
          ) VALUES ('unrelated-provider-lease', ${retainedId}, 'provider',
            ${yield* Effect.promise(() => nodeFs.realpath(unrelatedPath))},
            ${unrelatedStats.dev}, ${unrelatedStats.ino}, ${NOW}, ${NOW})
        `))._tag,
        "Success",
      );

      assert.equal(
        (yield* Effect.exit(sql`
          INSERT INTO worktree_runtime_leases (
            lease_id, thread_id, runtime_kind, canonical_path, device, inode, acquired_at, updated_at
          ) VALUES ('alias-provider-lease', ${retainedId}, 'provider', ${canonical},
            ${claimedStats.dev}, ${claimedStats.ino}, ${NOW}, ${NOW})
        `))._tag,
        "Failure",
      );
      const nestedStats = yield* Effect.promise(() => nodeFs.lstat(nestedPath));
      assert.equal(
        (yield* Effect.exit(sql`
          INSERT INTO worktree_runtime_leases (
            lease_id, thread_id, runtime_kind, canonical_path, device, inode, acquired_at, updated_at
          ) VALUES ('nested-provider-lease', ${retainedId}, 'provider',
            ${yield* Effect.promise(() => nodeFs.realpath(nestedPath))},
            ${nestedStats.dev}, ${nestedStats.ino}, ${NOW}, ${NOW})
        `))._tag,
        "Failure",
      );

      yield* sql`DELETE FROM purge_resource_claims WHERE entity_id = ${deletingId}`;
      const livePath = `${config.worktreesDir}/live-worktree`;
      yield* fs.makeDirectory(livePath);
      const liveThread = ThreadId.makeUnsafe("claim-live-thread");
      yield* seedThread({ projectId, threadId: liveThread, worktreePath: livePath });
      const stats = yield* Effect.promise(() => nodeFs.lstat(livePath));
      yield* sql`
        INSERT INTO worktree_runtime_leases (
          lease_id, thread_id, runtime_kind, canonical_path, device, inode, acquired_at, updated_at
        ) VALUES ('live-lease', ${liveThread}, 'terminal', ${yield* Effect.promise(() => nodeFs.realpath(livePath))},
          ${stats.dev}, ${stats.ino}, ${NOW}, ${NOW})
      `;
      assert.equal((yield* Effect.exit(purge.requestThread(liveThread)))._tag, "Failure");
    }),
  );

  it.effect("serializes computer-use activity leases against deletion claims", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("claim-activity-project");
      const threadId = ThreadId.makeUnsafe("claim-activity-thread");
      yield* seedThread({ projectId, threadId });
      yield* sql`
        INSERT INTO thread_activity_leases (lease_id, thread_id, activity_kind, acquired_at)
        VALUES ('activity-lease', ${threadId}, 'computer-use', ${NOW})
      `;
      assert.equal((yield* Effect.exit(purge.requestThread(threadId)))._tag, "Failure");
      yield* sql`DELETE FROM thread_activity_leases WHERE lease_id = 'activity-lease'`;
      yield* purge.requestThread(threadId);
      yield* sql`UPDATE projection_threads SET deleting_at = ${NOW} WHERE thread_id = ${threadId}`;
      assert.equal(
        (yield* Effect.exit(sql`
          INSERT INTO thread_activity_leases (lease_id, thread_id, activity_kind, acquired_at)
          VALUES ('late-activity-lease', ${threadId}, 'computer-use', ${NOW})
        `))._tag,
        "Failure",
      );
    }),
  );

  it.effect("ignores unrelated worktree metadata outside managed storage", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const projectId = ProjectId.makeUnsafe("claim-malformed-worktree-project");
      const deletingId = ThreadId.makeUnsafe("claim-malformed-worktree-deleting");
      const unrelatedId = ThreadId.makeUnsafe("claim-malformed-worktree-unrelated");
      const worktreePath = `${config.worktreesDir}/owned-worktree`;
      yield* fs.makeDirectory(worktreePath);
      yield* seedThread({ projectId, threadId: deletingId, worktreePath });
      yield* seedThread({
        projectId,
        threadId: unrelatedId,
        worktreePath: "/outside-bigbud-managed-storage",
      });

      assert.equal((yield* Effect.exit(purge.requestThread(deletingId)))._tag, "Success");
    }),
  );

  it.effect("fails verification when an unclaimed log rotation appears after capture", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const projectId = ProjectId.makeUnsafe("claim-late-log-project");
      const threadId = ThreadId.makeUnsafe("claim-late-log-thread");
      yield* seedThread({ projectId, threadId });
      yield* fs.writeFileString(`${config.providerLogsDir}/${threadId}.log`, "captured");
      const job = yield* purge.requestThread(threadId);
      yield* fs.writeFileString(`${config.providerLogsDir}/${threadId}.log.1`, "late");
      yield* sql`
        INSERT INTO orchestration_deletion_markers (
          entity_kind, entity_id, deletion_sequence, deleted_at
        ) VALUES ('thread', ${threadId}, 7001, ${NOW})
      `;
      assert.equal((yield* Effect.exit(purge.run(job)))._tag, "Failure");
      assert.isTrue(yield* fs.exists(`${config.providerLogsDir}/${threadId}.log.1`));
    }),
  );
});

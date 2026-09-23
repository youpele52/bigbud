import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { persistManagedAttachment } from "../../attachments/managedAttachmentOwnership.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../startup/config.ts";
import { discoverThreadDeletionFiles } from "./ThreadDeletion.files.ts";

const layer = it.layer(
  Layer.mergeAll(
    SqlitePersistenceMemory,
    ServerConfig.layerTest(process.cwd(), { prefix: "thread-deletion-files-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
);
const now = "2026-09-23T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("thread-11111111-1111-4111-8111-111111111111");
const otherThreadId = ThreadId.makeUnsafe("thread-22222222-2222-4222-8222-222222222222");
const attachmentId = `${threadId}-33333333-3333-4333-8333-333333333333`;
const relativePath = `${attachmentId}.png`;
const attachment = JSON.stringify([
  { type: "image", id: attachmentId, name: "image.png", mimeType: "image/png", sizeBytes: 3 },
]);

layer("thread deletion file provenance", (it) => {
  it.effect("retains external worktrees and only removes verified exclusive attachments", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig;
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project', 'Project', '/project', '[]', ${now}, ${now})`;
      for (const id of [threadId, otherThreadId]) {
        yield* sql`INSERT INTO projection_threads
          (thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, worktree_path, created_at, updated_at)
          VALUES (${id}, 'project', ${id}, '{"provider":"codex","model":"test"}',
            'full-access', 'default', ${id === threadId ? "/external/worktree" : null},
            ${now}, ${now})`;
      }
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, attachments_json, is_streaming,
          created_at, updated_at)
        VALUES ('message', ${threadId}, 'user', 'image', ${attachment}, 0, ${now}, ${now})`;
      const destination = join(config.attachmentsDir, relativePath);
      yield* persistManagedAttachment({
        attachmentsDir: config.attachmentsDir,
        attachmentId,
        creatorThreadId: threadId,
        destination,
        bytes: Buffer.from("one"),
        write: Effect.promise(() => writeFile(destination, "one").then(() => true)),
      });
      const discovered = yield* discoverThreadDeletionFiles({
        rootThreadId: threadId,
        threadIds: [threadId],
      });
      assert.equal(discovered.retainedExternalWorktrees.length, 1);
      assert.equal(discovered.retainedExternalWorktrees[0]?.recordedPath, "/external/worktree");
      assert.deepEqual(
        discovered.directResources.map((resource) => resource.resourceId),
        [`attachment:${relativePath}`],
      );

      const remotePath = join(config.worktreesDir, "remote-name-collision");
      yield* sql`UPDATE projection_threads SET worktree_path = ${remotePath},
        workspace_execution_target_id = 'ssh:remote'
        WHERE thread_id = ${threadId}`;
      const remote = yield* discoverThreadDeletionFiles({
        rootThreadId: threadId,
        threadIds: [threadId],
      });
      assert.deepEqual(remote.worktreeResources, []);
      assert.equal(remote.retainedExternalWorktrees[0]?.recordedPath, remotePath);
      yield* sql`UPDATE projection_threads SET worktree_path = '/external/worktree',
        workspace_execution_target_id = 'local'
        WHERE thread_id = ${threadId}`;

      yield* sql`UPDATE projection_threads SET worktree_path = ${remotePath}
        WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE projection_threads SET worktree_path = ${remotePath},
        workspace_execution_target_id = 'ssh:remote'
        WHERE thread_id = ${otherThreadId}`;
      const collision = yield* Effect.exit(
        discoverThreadDeletionFiles({ rootThreadId: threadId, threadIds: [threadId] }),
      );
      assert.isTrue(Exit.isFailure(collision));
      yield* sql`UPDATE projection_threads SET worktree_path = '/external/worktree'
        WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE projection_threads SET worktree_path = NULL,
        workspace_execution_target_id = 'local'
        WHERE thread_id = ${otherThreadId}`;

      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, attachments_json, is_streaming,
          created_at, updated_at)
        VALUES ('shared', ${otherThreadId}, 'user', 'image', ${attachment}, 0, ${now}, ${now})`;
      const shared = yield* discoverThreadDeletionFiles({
        rootThreadId: threadId,
        threadIds: [threadId],
      });
      assert.equal(shared.directResources.length, 0);
      assert.deepEqual(
        shared.retainedResources.map((resource) => resource.resourceId),
        [`attachment:${relativePath}`],
      );

      yield* sql`UPDATE projection_threads SET deleted_at = ${now}
        WHERE thread_id = ${otherThreadId}`;
      const onlyDeletedReference = yield* discoverThreadDeletionFiles({
        rootThreadId: threadId,
        threadIds: [threadId],
      });
      assert.deepEqual(
        onlyDeletedReference.directResources.map((resource) => resource.resourceId),
        [`attachment:${relativePath}`],
      );
      yield* sql`UPDATE projection_threads SET deleted_at = NULL
        WHERE thread_id = ${otherThreadId}`;

      yield* Effect.promise(() => writeFile(destination, "two"));
      const changed = yield* discoverThreadDeletionFiles({
        rootThreadId: threadId,
        threadIds: [threadId],
      });
      assert.equal(changed.directResources.length, 0);
      assert.deepEqual(
        changed.retainedUnverifiedAttachments.map((resource) => resource.reason),
        ["content_changed"],
      );

      yield* sql`UPDATE projection_threads SET worktree_path = ${`${config.worktreesDir}/../outside`}
        WHERE thread_id = ${threadId}`;
      const unsafe = yield* Effect.exit(
        discoverThreadDeletionFiles({ rootThreadId: threadId, threadIds: [threadId] }),
      );
      assert.isTrue(Exit.isFailure(unsafe));

      const malformed = JSON.stringify([
        {
          type: "image",
          id: attachmentId,
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: "unknown",
        },
      ]);
      yield* sql`UPDATE projection_threads SET worktree_path = '/external/worktree'
        WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE projection_thread_messages SET attachments_json = ${malformed}
        WHERE message_id = 'message'`;
      const unverified = yield* discoverThreadDeletionFiles({
        rootThreadId: threadId,
        threadIds: [threadId],
      });
      assert.equal(unverified.directResources.length, 0);
      assert.include(
        unverified.retainedUnverifiedAttachments.map((resource) => resource.reason),
        "manifest_invalid",
      );

      // The original creator may have been removed while another thread retained the file.
      // Durable ownership and the surviving manifest authorize its eventual final cleanup.
      yield* Effect.promise(() => writeFile(destination, "one"));
      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'message'`;
      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
      const finalReference = yield* discoverThreadDeletionFiles({
        rootThreadId: otherThreadId,
        threadIds: [otherThreadId],
      });
      assert.deepEqual(
        finalReference.directResources.map((resource) => resource.resourceId),
        [`attachment:${relativePath}`],
      );
      assert.deepEqual(finalReference.retainedUnverifiedAttachments, []);
    }),
  );
});

import { createHash } from "node:crypto";
import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { discoverThreadDeletionFiles } from "../../deletion/Layers/ThreadDeletion.files.ts";
import { ServerConfig } from "../../startup/config.ts";
import { AttachmentMaintenance } from "../Services/AttachmentMaintenance.ts";
import { runAttachmentOwnershipBackfill } from "./AttachmentMaintenance.backfill.ts";
import {
  attachmentIdFor,
  makeAttachmentMaintenanceTestLayer,
  OTHER_THREAD_ID,
  referenceAttachment,
  seedThread,
  THREAD_ID,
  writeAttachmentFile,
} from "./AttachmentMaintenance.test.helpers.ts";
import { listManagedAttachmentFiles } from "./AttachmentMaintenance.listing.ts";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

const ownershipRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    attachmentId: string;
    relativePath: string;
    creatorThreadId: string;
    contentSha256: string;
    sizeBytes: number;
    lifecycle: string;
    fileDevice: string | null;
    fileId: string | null;
  }>`
    SELECT attachment_id AS "attachmentId", relative_path AS "relativePath",
      creator_thread_id AS "creatorThreadId", content_sha256 AS "contentSha256",
      size_bytes AS "sizeBytes", lifecycle, file_device AS "fileDevice", file_id AS "fileId"
    FROM managed_attachment_ownership ORDER BY attachment_id
  `;
});

it.effect("records ownership for legacy referenced files so thread deletion can remove them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { attachmentsDir: root } = yield* ServerConfig;
    const maintenance = yield* AttachmentMaintenance;
    yield* seedThread(THREAD_ID);
    yield* seedThread(OTHER_THREAD_ID);
    const legacyId = attachmentIdFor(THREAD_ID, 1);
    const legacy = yield* Effect.promise(() =>
      writeAttachmentFile(root, `${legacyId}.png`, "legacy bytes"),
    );
    // Only a soft-deleted thread references this one: no live reference, no ownership.
    const deletedOnlyId = attachmentIdFor(OTHER_THREAD_ID, 2);
    yield* Effect.promise(() => writeAttachmentFile(root, `${deletedOnlyId}.png`, "deleted"));
    // Two files claim one ID: ambiguous, skipped.
    const ambiguousId = attachmentIdFor(THREAD_ID, 3);
    yield* Effect.promise(() => writeAttachmentFile(root, `${ambiguousId}.png`, "a"));
    yield* Effect.promise(() => writeAttachmentFile(root, `${ambiguousId}.jpg`, "b"));
    // Referenced, but the file is gone.
    const missingId = attachmentIdFor(THREAD_ID, 4);
    yield* referenceAttachment(THREAD_ID, "message-legacy", legacyId);
    yield* referenceAttachment(OTHER_THREAD_ID, "message-deleted", deletedOnlyId);
    yield* referenceAttachment(THREAD_ID, "message-ambiguous", ambiguousId);
    yield* referenceAttachment(THREAD_ID, "message-missing", missingId);
    yield* sql`UPDATE projection_threads SET deleted_at = '2026-09-02T00:00:00.000Z'
      WHERE thread_id = ${OTHER_THREAD_ID}`;

    const result = yield* maintenance.runTick();
    assert.deepEqual(
      { recorded: result.backfill.recorded, skipped: result.backfill.skipped },
      { recorded: 1, skipped: 2 },
    );
    assert.equal(result.backfill.pending, 0);
    const stats = yield* Effect.promise(() => lstat(legacy, { bigint: true }));
    assert.deepEqual(yield* ownershipRows, [
      {
        attachmentId: legacyId,
        relativePath: `${legacyId}.png`,
        creatorThreadId: THREAD_ID,
        contentSha256: sha256("legacy bytes"),
        sizeBytes: "legacy bytes".length,
        lifecycle: "published",
        fileDevice: stats.dev.toString(),
        fileId: stats.ino.toString(),
      },
    ]);
    // A finished pass is not repeated within a day.
    assert.equal((yield* maintenance.runTick()).backfill.scanned, 0);

    const discovered = yield* discoverThreadDeletionFiles({
      rootThreadId: ThreadId.makeUnsafe(THREAD_ID),
      threadIds: [ThreadId.makeUnsafe(THREAD_ID)],
    });
    assert.include(
      discovered.directResources.map((resource) => resource.resourceId),
      `attachment:${legacyId}.png`,
    );
  }).pipe(Effect.provide(makeAttachmentMaintenanceTestLayer())),
);

it.effect("skips a file whose content changes between the two hash passes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { attachmentsDir: root } = yield* ServerConfig;
    yield* seedThread(THREAD_ID);
    const attachmentId = attachmentIdFor(THREAD_ID, 9);
    yield* Effect.promise(() => writeAttachmentFile(root, `${attachmentId}.png`, "original"));
    yield* referenceAttachment(THREAD_ID, "message-changing", attachmentId);
    const files = listManagedAttachmentFiles(yield* Effect.promise(() => readdir(root)));
    const result = yield* runAttachmentOwnershipBackfill({
      context: {
        sql,
        root: path.resolve(root),
        nowMs: Date.now(),
        deadlineReached: () => false,
        fileOps: { remaining: 50 },
      },
      state: { cursor: "", passCompletedAtMs: null },
      filesById: new Map(files.map((file) => [file.attachmentId, [file.fileName]])),
      // Same length, same inode, different bytes: only the hash can tell.
      beforeVerify: (absolutePath) => writeFile(absolutePath, "ORIGINAL"),
    });
    assert.deepEqual(
      { recorded: result.recorded, skipped: result.skipped },
      { recorded: 0, skipped: 1 },
    );
    assert.deepEqual(yield* ownershipRows, []);
  }).pipe(Effect.provide(makeAttachmentMaintenanceTestLayer())),
);

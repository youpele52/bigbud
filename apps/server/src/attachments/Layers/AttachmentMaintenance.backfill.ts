/**
 * Ownership backfill for attachments written before migration 121. Since that migration every
 * writer records ownership before it writes the file (`persistManagedAttachment`), so a file a
 * live thread references with no ownership row is a legacy file. Recording its device, inode and
 * hash as `published` lets the normal deletion pipeline (`ThreadDeletion.files.ts`) remove it
 * with its thread, through the same identity and hash checks as any other managed file.
 *
 * A file is recorded only if it hashes the same twice, with the second pass through the shared
 * `verifiedIdentity` check, and keeps its device and inode throughout. Anything else is skipped
 * and keeps today's behaviour: no ownership row, so the file is retained.
 *
 * @module AttachmentMaintenance.backfill
 */
import type { BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { managedRelativePath } from "../../deletion/Layers/EntityPurge.resources.ts";
import {
  ATTACHMENT_BACKFILL_BATCH_SIZE,
  ATTACHMENT_BACKFILL_SCAN_LIMIT,
  ATTACHMENT_BACKFILL_WINDOW_SQL,
} from "../attachmentMaintenance.layout.ts";
import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { verifiedIdentity } from "../managedAttachmentOwnership.ts";
import { isRegularFile, lstatIfPresent, sameFile } from "./AttachmentMaintenance.fs.ts";
import type { AttachmentTickContext } from "./AttachmentMaintenance.holds.ts";

/** Legacy files cannot appear after migration 121, so a finished pass is repeated only daily. */
export const ATTACHMENT_BACKFILL_RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface AttachmentBackfillState {
  cursor: string;
  passCompletedAtMs: number | null;
}

export interface AttachmentBackfillResult {
  readonly scanned: number;
  readonly recorded: number;
  readonly skipped: number;
  readonly pending: number;
}

export interface AttachmentBackfillInput {
  readonly context: AttachmentTickContext;
  readonly state: AttachmentBackfillState;
  /** Managed file names in the root, by attachment ID. */
  readonly filesById: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Test seam: runs between the two hash passes to simulate a concurrent write. */
  readonly beforeVerify?: (absolutePath: string) => Promise<void>;
}

type BackfillOutcome = "recorded" | "skipped";

export const runAttachmentOwnershipBackfill = Effect.fn("AttachmentMaintenance.backfill")(
  function* (input: AttachmentBackfillInput) {
    const { context, state } = input;
    const idle = { scanned: 0, recorded: 0, skipped: 0, pending: 0 };
    if (state.passCompletedAtMs !== null) {
      if (context.nowMs - state.passCompletedAtMs < ATTACHMENT_BACKFILL_RESCAN_INTERVAL_MS) {
        return idle satisfies AttachmentBackfillResult;
      }
      state.cursor = "";
      state.passCompletedAtMs = null;
    }
    const window = yield* context.sql.unsafe<{ attachmentId: string; candidate: number }>(
      ATTACHMENT_BACKFILL_WINDOW_SQL,
      [state.cursor, ATTACHMENT_BACKFILL_SCAN_LIMIT],
    );
    const result = { ...idle };
    let examined = 0;
    for (const row of window) {
      if (Number(row.candidate) === 1) {
        if (
          result.recorded + result.skipped >= ATTACHMENT_BACKFILL_BATCH_SIZE ||
          context.deadlineReached()
        ) {
          break;
        }
        const outcome = yield* backfillOne(input, row.attachmentId);
        result[outcome] += 1;
        yield* Effect.yieldNow;
      }
      examined += 1;
      result.scanned += 1;
      state.cursor = row.attachmentId;
    }
    if (examined === window.length && window.length < ATTACHMENT_BACKFILL_SCAN_LIMIT) {
      state.passCompletedAtMs = context.nowMs;
      return result satisfies AttachmentBackfillResult;
    }
    const waiting = window.slice(examined).filter((row) => Number(row.candidate) === 1).length;
    return { ...result, pending: Math.max(1, waiting) } satisfies AttachmentBackfillResult;
  },
);

async function hashStableFile(absolutePath: string) {
  const before = await lstatIfPresent(absolutePath);
  if (!isRegularFile(before)) throw new Error("file_identity_invalid");
  const digest = createHash("sha256")
    .update(await nodeFs.readFile(absolutePath))
    .digest("hex");
  const after = await lstatIfPresent(absolutePath);
  if (!isRegularFile(after) || !sameFile(before, after) || after.size !== before.size) {
    throw new Error("file_identity_changed");
  }
  return { digest, stats: after };
}

async function verifyLegacyFile(
  root: string,
  absolutePath: string,
  beforeVerify: AttachmentBackfillInput["beforeVerify"],
): Promise<{ readonly digest: string; readonly identity: BigIntStats }> {
  const first = await hashStableFile(absolutePath);
  await beforeVerify?.(absolutePath);
  // Second pass through the same check the staged-upload reconcile uses.
  const identity = await verifiedIdentity({
    attachmentsDir: root,
    destination: absolutePath,
    contentSha256: first.digest,
    sizeBytes: Number(first.stats.size),
  });
  if (!sameFile(identity, first.stats)) throw new Error("file_identity_changed");
  return { digest: first.digest, identity };
}

const backfillOne = Effect.fn("AttachmentMaintenance.backfillOne")(function* (
  input: AttachmentBackfillInput,
  attachmentId: string,
) {
  const { context } = input;
  const fileNames = input.filesById.get(attachmentId) ?? [];
  // Missing, or several extensions for one ID: no single file can be bound to the ID.
  const fileName = fileNames.length === 1 ? fileNames[0] : undefined;
  if (fileName === undefined) return "skipped" satisfies BackfillOutcome;
  const absolutePath = path.join(context.root, fileName);
  if (managedRelativePath(context.root, absolutePath) !== fileName) {
    return "skipped" satisfies BackfillOutcome;
  }
  const verified = yield* Effect.tryPromise(() =>
    verifyLegacyFile(context.root, absolutePath, input.beforeVerify),
  ).pipe(Effect.exit);
  if (Exit.isFailure(verified)) {
    yield* Effect.logDebug("legacy attachment ownership skipped", {
      fileName,
      cause: String(verified.cause),
    });
    return "skipped" satisfies BackfillOutcome;
  }
  const threads = yield* context.sql<{ threadId: string }>`
    SELECT DISTINCT ref.thread_id AS "threadId"
    FROM projection_thread_attachment_refs AS ref
    JOIN projection_threads AS live ON live.thread_id = ref.thread_id
    WHERE ref.attachment_id = ${attachmentId} AND live.deleted_at IS NULL
    ORDER BY ref.thread_id LIMIT 50
  `;
  const segment = parseThreadSegmentFromAttachmentId(attachmentId);
  const creator =
    threads.find((thread) => toSafeThreadAttachmentSegment(thread.threadId) === segment) ??
    threads[0];
  if (!creator) return "skipped" satisfies BackfillOutcome;
  const { digest, identity } = verified.value;
  const nowIso = new Date(context.nowMs).toISOString();
  yield* context.sql`
    INSERT INTO managed_attachment_ownership (
      attachment_id, relative_path, creator_thread_id, content_sha256, size_bytes,
      lifecycle, file_device, file_id, created_at, published_at
    ) VALUES (
      ${attachmentId}, ${fileName}, ${creator.threadId}, ${digest}, ${Number(identity.size)},
      'published', ${identity.dev.toString()}, ${identity.ino.toString()}, ${nowIso}, ${nowIso}
    )
    ON CONFLICT DO NOTHING
  `;
  const [stored] = yield* context.sql<{ relativePath: string; contentSha256: string }>`
    SELECT relative_path AS "relativePath", content_sha256 AS "contentSha256"
    FROM managed_attachment_ownership WHERE attachment_id = ${attachmentId}
  `;
  return stored?.relativePath === fileName && stored.contentSha256 === digest
    ? ("recorded" satisfies BackfillOutcome)
    : ("skipped" satisfies BackfillOutcome);
});

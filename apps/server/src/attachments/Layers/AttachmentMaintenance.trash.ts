/**
 * Trash pass: restores trashed attachments that are referenced again and deletes the rest once
 * their trash retention has passed. Restores come first, so a re-referenced file is never
 * starved by deletes; both share the tick's file-operation cap.
 *
 * @module AttachmentMaintenance.trash
 */
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  ATTACHMENT_HOLD_CHUNK_SIZE,
  ATTACHMENT_TRASH_DIRECTORY,
  ATTACHMENT_TRASH_RETENTION_MS,
  parseAttachmentTrashEntryName,
  type AttachmentTrashEntry,
} from "../attachmentMaintenance.layout.ts";
import {
  compareNames,
  deleteTrashedFile,
  readDirectoryIfRealDirectory,
  restoreWithoutClobber,
} from "./AttachmentMaintenance.fs.ts";
import {
  currentAttachmentHold,
  loadAttachmentHolds,
  type AttachmentTickContext,
} from "./AttachmentMaintenance.holds.ts";

export interface AttachmentTrashPassResult {
  readonly deleted: number;
  readonly restored: number;
  readonly held: number;
  readonly failed: number;
  readonly pending: number;
}

type TrashAction = { readonly entry: AttachmentTrashEntry; readonly kind: "restore" | "delete" };

export const runAttachmentTrashPass = Effect.fn("AttachmentMaintenance.trashPass")(function* (
  context: AttachmentTickContext,
) {
  const result = { deleted: 0, restored: 0, held: 0, failed: 0, pending: 0 };
  const trashDirectory = path.join(context.root, ATTACHMENT_TRASH_DIRECTORY);
  const listing = yield* Effect.tryPromise(() => readDirectoryIfRealDirectory(trashDirectory));
  if (listing === "missing") return result satisfies AttachmentTrashPassResult;
  if (listing === "invalid") {
    yield* Effect.logWarning("attachment trash is not a real directory; skipping", {
      trashDirectory,
    });
    return { ...result, failed: 1 } satisfies AttachmentTrashPassResult;
  }
  const entries = listing
    .flatMap((name) => parseAttachmentTrashEntryName(name) ?? [])
    .toSorted((left, right) => compareNames(left.entryName, right.entryName));

  const restores: Array<TrashAction> = [];
  const deletes: Array<TrashAction> = [];
  let examined = 0;
  for (let index = 0; index < entries.length; index += ATTACHMENT_HOLD_CHUNK_SIZE) {
    if (context.deadlineReached()) break;
    const chunk = entries.slice(index, index + ATTACHMENT_HOLD_CHUNK_SIZE);
    const holds = yield* loadAttachmentHolds(context.sql, chunk);
    for (const entry of chunk) {
      const hold = holds.get(entry.fileName);
      if (hold === "referenced") restores.push({ entry, kind: "restore" });
      else if (hold) result.held += 1;
      else if (context.nowMs - entry.trashedAtMs >= ATTACHMENT_TRASH_RETENTION_MS)
        deletes.push({ entry, kind: "delete" });
    }
    examined += chunk.length;
  }
  // Entries the budget left unexamined may need a restore; count them as pending work.
  result.pending += entries.length - examined;

  for (const action of [...restores, ...deletes]) {
    if (context.fileOps.remaining <= 0 || context.deadlineReached()) {
      result.pending += 1;
      continue;
    }
    const outcome = yield* applyTrashAction(context, trashDirectory, action);
    if (outcome !== "skipped") context.fileOps.remaining -= 1;
    if (outcome === "restored") result.restored += 1;
    else if (outcome === "deleted") result.deleted += 1;
    else if (outcome === "held") result.held += 1;
    else if (outcome === "failed") result.failed += 1;
    yield* Effect.yieldNow;
  }
  return result satisfies AttachmentTrashPassResult;
});

const applyTrashAction = Effect.fn("AttachmentMaintenance.trashAction")(function* (
  context: AttachmentTickContext,
  trashDirectory: string,
  action: TrashAction,
) {
  const { entry } = action;
  const trashPath = path.join(trashDirectory, entry.entryName);
  const destination = path.join(context.root, entry.fileName);
  // A delete re-checks references at the last moment; a fresh reference turns it into a restore.
  const hold =
    action.kind === "delete" ? yield* currentAttachmentHold(context.sql, entry) : "referenced";
  if (hold !== undefined && hold !== "referenced") return "held" as const;
  if (hold === "referenced") {
    const restored = yield* Effect.tryPromise(() =>
      restoreWithoutClobber(trashPath, destination),
    ).pipe(Effect.exit);
    if (Exit.isFailure(restored)) {
      yield* Effect.logWarning("attachment restore from trash failed", {
        entry: entry.entryName,
        cause: String(restored.cause),
      });
      return "failed" as const;
    }
    if (restored.value === "conflict") {
      yield* Effect.logWarning("attachment restore blocked by an existing file", {
        entry: entry.entryName,
      });
      return "held" as const;
    }
    return "restored" as const;
  }
  const deleted = yield* Effect.tryPromise(() => deleteTrashedFile(trashPath)).pipe(Effect.exit);
  if (Exit.isFailure(deleted)) return "failed" as const;
  if (!deleted.value) return "skipped" as const;
  // The file is gone, so its ownership row no longer protects anything.
  yield* context.sql`
    DELETE FROM managed_attachment_ownership
    WHERE attachment_id = ${entry.attachmentId} AND relative_path = ${entry.fileName}
      AND lifecycle = 'published'
  `;
  return "deleted" as const;
});

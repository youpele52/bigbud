/**
 * Orphan scan: walks the managed files in name order from a cursor, and moves each regular file
 * that is past the grace period and has no reference or hold into the trash. References are
 * read in batches, then re-checked for each file right before its move.
 *
 * Skipped without a move: names outside the managed layout (staging directories, dotfiles, the
 * trash itself), symlinks and other non-regular entries, files younger than the grace period,
 * referenced files, staged or blocked uploads (left to the staged-upload reconcile) and files an
 * in-flight deletion owns.
 *
 * A reference can land between the last hold check and the rename (the database and the
 * filesystem cannot change together). So holds are read once more after the move, and a file
 * that became held (or whose re-check failed) is restored at once, without clobbering. What
 * remains: a reader that resolves the path in the few milliseconds between the rename and that
 * restore sees it missing, and a reference landing after the re-check is restored by the next
 * tick's trash pass, which runs before anything else (restores first, then deletes).
 *
 * @module AttachmentMaintenance.sweep
 */
import type { BigIntStats } from "node:fs";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  ATTACHMENT_HOLD_CHUNK_SIZE,
  ATTACHMENT_ORPHAN_GRACE_MS,
  attachmentFileAgeMs,
  attachmentTrashEntryName,
} from "../attachmentMaintenance.layout.ts";
import {
  ensureTrashDirectory,
  isRegularFile,
  lstatIfPresent,
  moveToTrash,
  restoreWithoutClobber,
  sameFile,
} from "./AttachmentMaintenance.fs.ts";
import {
  currentAttachmentHold,
  loadAttachmentHolds,
  type AttachmentTickContext,
  type ManagedAttachmentFile,
} from "./AttachmentMaintenance.holds.ts";

export interface AttachmentSweepState {
  /** Last file name fully handled in the current pass; `""` starts a new pass. */
  cursor: string;
}

export interface AttachmentOrphanScanResult {
  readonly scanned: number;
  readonly trashed: number;
  readonly held: number;
  readonly failed: number;
  readonly pending: number;
}

interface AgedFile extends ManagedAttachmentFile {
  readonly stats: BigIntStats;
}

const isPastGrace = (stats: BigIntStats, nowMs: number) =>
  attachmentFileAgeMs({
    nowMs,
    mtimeMs: Number(stats.mtimeMs),
    ctimeMs: Number(stats.ctimeMs),
  }) >= ATTACHMENT_ORPHAN_GRACE_MS;

/** `files` must be sorted by file name in code-unit order. */
export const runAttachmentOrphanScan = Effect.fn("AttachmentMaintenance.orphanScan")(function* (
  context: AttachmentTickContext,
  state: AttachmentSweepState,
  files: ReadonlyArray<ManagedAttachmentFile>,
) {
  const result = { scanned: 0, trashed: 0, held: 0, failed: 0, pending: 0 };
  let trashDirectory: string | null = null;
  let index = files.findIndex((file) => file.fileName > state.cursor);
  if (index < 0) index = files.length;

  scan: while (index < files.length) {
    if (context.deadlineReached()) break;
    const chunk = files.slice(index, index + ATTACHMENT_HOLD_CHUNK_SIZE);
    const aged: Array<AgedFile> = [];
    for (const file of chunk) {
      const stats = yield* Effect.tryPromise(() =>
        lstatIfPresent(path.join(context.root, file.fileName)),
      ).pipe(Effect.orElseSucceed(() => null));
      result.scanned += 1;
      if (isRegularFile(stats) && isPastGrace(stats, context.nowMs)) aged.push({ ...file, stats });
    }
    const holds = yield* loadAttachmentHolds(context.sql, aged);
    const orphans = aged.filter((file) => {
      const hold = holds.get(file.fileName);
      if (hold !== undefined && hold !== "referenced") result.held += 1;
      return hold === undefined;
    });

    for (const [orphanIndex, orphan] of orphans.entries()) {
      if (context.fileOps.remaining <= 0 || context.deadlineReached()) {
        // Resume just before this orphan next tick.
        result.pending += orphans.length - orphanIndex;
        const resumeAt = files.findIndex((file) => file.fileName === orphan.fileName);
        state.cursor = resumeAt > 0 ? (files[resumeAt - 1]?.fileName ?? "") : "";
        index = resumeAt;
        break scan;
      }
      if (trashDirectory === null) {
        const ensured = yield* Effect.tryPromise(() => ensureTrashDirectory(context.root)).pipe(
          Effect.exit,
        );
        if (Exit.isFailure(ensured)) {
          yield* Effect.logWarning("attachment trash unavailable; orphan sweep paused", {
            cause: String(ensured.cause),
          });
          result.failed += 1;
          result.pending += orphans.length - orphanIndex;
          index = files.length;
          state.cursor = "";
          break scan;
        }
        trashDirectory = ensured.value;
      }
      const outcome = yield* trashOrphan(context, trashDirectory, orphan);
      if (outcome === "trashed") {
        result.trashed += 1;
        context.fileOps.remaining -= 1;
      } else if (outcome === "held") result.held += 1;
      else if (outcome === "failed") result.failed += 1;
      yield* Effect.yieldNow;
    }
    index += chunk.length;
    state.cursor = chunk.at(-1)?.fileName ?? state.cursor;
  }

  // Unscanned files may hold orphans; a finished pass starts over next tick.
  result.pending += files.length - index;
  if (index >= files.length) state.cursor = "";
  return result satisfies AttachmentOrphanScanResult;
});

const trashOrphan = Effect.fn("AttachmentMaintenance.trashOrphan")(function* (
  context: AttachmentTickContext,
  trashDirectory: string,
  orphan: AgedFile,
) {
  // Last-moment checks: a new reference or a replaced file cancels the move.
  const hold = yield* currentAttachmentHold(context.sql, orphan);
  if (hold === "referenced") return "skipped" as const;
  if (hold !== undefined) return "held" as const;
  const current = yield* Effect.tryPromise(() =>
    lstatIfPresent(path.join(context.root, orphan.fileName)),
  ).pipe(Effect.orElseSucceed(() => null));
  if (
    !isRegularFile(current) ||
    !sameFile(current, orphan.stats) ||
    !isPastGrace(current, context.nowMs)
  ) {
    return "skipped" as const;
  }
  const moved = yield* Effect.tryPromise(() =>
    moveToTrash({
      root: context.root,
      trashDirectory,
      fileName: orphan.fileName,
      expected: current,
      nowMs: context.nowMs,
    }),
  ).pipe(Effect.exit);
  if (Exit.isFailure(moved)) {
    yield* Effect.logWarning("attachment move to trash failed", {
      fileName: orphan.fileName,
      cause: String(moved.cause),
    });
    return "failed" as const;
  }
  if (moved.value !== "trashed") return "skipped" as const;
  return yield* confirmTrashed(context, trashDirectory, orphan);
});

/** Re-checks holds after the move; a file that became held goes straight back. */
const confirmTrashed = Effect.fn("AttachmentMaintenance.confirmTrashed")(function* (
  context: AttachmentTickContext,
  trashDirectory: string,
  orphan: AgedFile,
) {
  if (context.afterTrashMove) yield* context.afterTrashMove(orphan);
  const recheck = yield* Effect.exit(currentAttachmentHold(context.sql, orphan));
  if (Exit.isSuccess(recheck) && recheck.value === undefined) return "trashed" as const;
  const trashPath = path.join(
    trashDirectory,
    attachmentTrashEntryName(orphan.fileName, context.nowMs),
  );
  const restored = yield* Effect.tryPromise(() =>
    restoreWithoutClobber(trashPath, path.join(context.root, orphan.fileName)),
  ).pipe(Effect.exit);
  const log =
    Exit.isSuccess(recheck) && Exit.isSuccess(restored) ? Effect.logInfo : Effect.logWarning;
  yield* log("attachment held (or unverifiable) right after its move to trash; restoring", {
    fileName: orphan.fileName,
    hold: Exit.isSuccess(recheck) ? recheck.value : "unknown",
    restore: Exit.isSuccess(restored) ? restored.value : String(restored.cause),
  });
  // A failed restore leaves the file in the trash, where the trash pass restores it once held.
  return Exit.isSuccess(recheck) && recheck.value === "referenced"
    ? ("skipped" as const)
    : ("held" as const);
});

/**
 * Staging-directory cleanup: removes `.submission-upload-*` directories in the attachments root
 * that are older than 1 day. An upload creates its directory fresh, writes one file into it and
 * removes it whole, so an old one is a leftover (crash, or the leak fixed in
 * `Normalizer.attachmentStorage`). An empty one is removed; one that still holds only its old
 * staged file (a crash mid-upload) has that file unlinked first.
 *
 * Bounded: at most 100 candidates are examined per tick, in name order from an in-memory
 * cursor, so old non-empty directories cannot starve the rest. Only top-level names matching
 * the staging pattern are considered; symlinks, non-directories, young directories and any
 * holding something other than one old staged file are left alone (see
 * `removeEmptyDirectoryIfOld` and `removeStaleStagedUpload`).
 *
 * @module AttachmentMaintenance.uploadDirs
 */
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  isSubmissionUploadDirectoryName,
  SUBMISSION_UPLOAD_DIRECTORY_MAX_AGE_MS,
  SUBMISSION_UPLOAD_DIRECTORY_SCAN_LIMIT,
} from "../attachmentMaintenance.layout.ts";
import {
  compareNames,
  type EmptyDirectoryRemoval,
  removeEmptyDirectoryIfOld,
  removeStaleStagedUpload,
} from "./AttachmentMaintenance.fs.ts";
import type { AttachmentTickContext } from "./AttachmentMaintenance.holds.ts";

export interface UploadDirectorySweepState {
  /** Last staging-directory name examined in the current pass; `""` starts a new pass. */
  cursor: string;
}

export interface UploadDirectorySweepResult {
  readonly removed: number;
  readonly failed: number;
  /** Candidates not examined yet in this pass. */
  readonly pending: number;
}

async function removeStaleUploadDirectory(
  target: string,
  input: { readonly nowMs: number; readonly minAgeMs: number },
): Promise<EmptyDirectoryRemoval> {
  const outcome = await removeEmptyDirectoryIfOld(target, input);
  if (outcome !== "not-empty" || !(await removeStaleStagedUpload(target, input))) return outcome;
  // Unlinking the file just touched the directory; its age was checked above.
  return removeEmptyDirectoryIfOld(target, { ...input, minAgeMs: 0 });
}

export const runUploadDirectorySweep = Effect.fn("AttachmentMaintenance.uploadDirectorySweep")(
  function* (
    context: AttachmentTickContext,
    state: UploadDirectorySweepState,
    rootListing: ReadonlyArray<string>,
  ) {
    const candidates = rootListing
      .filter(isSubmissionUploadDirectoryName)
      .toSorted(compareNames)
      .filter((name) => compareNames(name, state.cursor) > 0);
    let removed = 0;
    let failed = 0;
    let examined = 0;
    for (const name of candidates) {
      if (examined >= SUBMISSION_UPLOAD_DIRECTORY_SCAN_LIMIT || context.deadlineReached()) break;
      examined += 1;
      state.cursor = name;
      const outcome = yield* Effect.tryPromise(() =>
        removeStaleUploadDirectory(path.join(context.root, name), {
          nowMs: context.nowMs,
          minAgeMs: SUBMISSION_UPLOAD_DIRECTORY_MAX_AGE_MS,
        }),
      ).pipe(Effect.exit);
      if (Exit.isFailure(outcome)) {
        failed += 1;
        yield* Effect.logWarning("stale upload directory removal failed", {
          name,
          cause: String(outcome.cause),
        });
      } else if (outcome.value === "removed") {
        removed += 1;
      }
      yield* Effect.yieldNow;
    }
    const pending = candidates.length - examined;
    // The pass reached the end: the next tick starts again from the first name.
    if (pending === 0) state.cursor = "";
    return { removed, failed, pending } satisfies UploadDirectorySweepResult;
  },
);

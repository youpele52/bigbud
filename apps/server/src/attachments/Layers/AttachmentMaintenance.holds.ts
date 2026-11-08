/**
 * Reference and hold lookups for attachment maintenance, plus the per-tick context shared by
 * the sweep, trash and backfill steps.
 *
 * @module AttachmentMaintenance.holds
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ATTACHMENT_HOLDS_SQL,
  attachmentHoldParams,
  indexAttachmentHolds,
  type AttachmentHoldReason,
  type AttachmentHoldRow,
} from "../attachmentMaintenance.layout.ts";

export interface ManagedAttachmentFile {
  readonly attachmentId: string;
  readonly fileName: string;
}

export interface AttachmentTickContext {
  readonly sql: SqlClient.SqlClient;
  /** Resolved managed attachments root. */
  readonly root: string;
  readonly nowMs: number;
  /** True once the tick's time budget is spent; checked at every file boundary. */
  readonly deadlineReached: () => boolean;
  /** File operations (trash moves, deletes, restores) left for this tick. */
  readonly fileOps: { remaining: number };
  /** Tests only: runs between a file's move to the trash and the hold re-check after it. */
  readonly afterTrashMove?: (file: ManagedAttachmentFile) => Effect.Effect<void>;
}

/** Holds for many files in one query; keyed by file name. */
export const loadAttachmentHolds = Effect.fn("AttachmentMaintenance.loadHolds")(function* (
  sql: SqlClient.SqlClient,
  files: ReadonlyArray<ManagedAttachmentFile>,
) {
  if (files.length === 0) return new Map<string, AttachmentHoldReason>();
  const rows = yield* sql.unsafe<AttachmentHoldRow>(
    ATTACHMENT_HOLDS_SQL,
    attachmentHoldParams(files),
  );
  return indexAttachmentHolds(files, rows);
});

/** Re-check for one file immediately before a move or delete. */
export const currentAttachmentHold = (sql: SqlClient.SqlClient, file: ManagedAttachmentFile) =>
  loadAttachmentHolds(sql, [file]).pipe(Effect.map((holds) => holds.get(file.fileName)));

/**
 * Layout and selection rules for attachment maintenance (ownership backfill and orphan sweep).
 * Shared by the server's `AttachmentMaintenance` layer and the read-only database size report,
 * so both classify files the same way. Pure: no I/O, no Effect.
 *
 * Managed layout: `<attachmentsDir>/<attachmentId><extension>`, flat. Swept files move to
 * `<attachmentsDir>/.trash/<trashedAtMs>__<fileName>`; the timestamp in the name is the only
 * trash state, so a crash between any two steps leaves a state the next tick can resume from.
 *
 * @module attachmentMaintenance.layout
 */
import {
  ATTACHMENT_FILENAME_EXTENSIONS,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
} from "./attachmentStore.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** An unreferenced file must be at least this old (by mtime and ctime) before it is trashed. */
export const ATTACHMENT_ORPHAN_GRACE_MS = 7 * DAY_MS;
/** A trashed file is deleted this long after it was moved, unless it is referenced again. */
export const ATTACHMENT_TRASH_RETENTION_MS = 7 * DAY_MS;
export const ATTACHMENT_TRASH_DIRECTORY = ".trash";
/** Trash moves, final deletes and restores share this per-tick cap. */
export const ATTACHMENT_SWEEP_FILE_LIMIT = 50;
export const ATTACHMENT_BACKFILL_BATCH_SIZE = 25;
/** Reference rows examined per backfill query, so one query never walks the whole index. */
export const ATTACHMENT_BACKFILL_SCAN_LIMIT = 200;
/** Files per batched hold lookup. */
export const ATTACHMENT_HOLD_CHUNK_SIZE = 100;
/** Prefix of the per-upload staging directories `persistSubmissionAttachment` creates. */
export const SUBMISSION_UPLOAD_DIRECTORY_PREFIX = ".submission-upload-";
/** The one file an upload writes into its staging directory before publishing it. */
export const SUBMISSION_UPLOAD_STAGED_FILE_NAME = "upload";
/**
 * A staging directory older than this belongs to no live upload and is removed: when empty, or
 * when it holds only its staged file (a crash before the upload removed it).
 */
export const SUBMISSION_UPLOAD_DIRECTORY_MAX_AGE_MS = DAY_MS;
/** Staging-directory candidates examined per tick (each costs one `lstat`, maybe one `rmdir`). */
export const SUBMISSION_UPLOAD_DIRECTORY_SCAN_LIMIT = 100;
const SUBMISSION_UPLOAD_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/** True only for a top-level `.submission-upload-<random>` name, nothing nested or unusual. */
export function isSubmissionUploadDirectoryName(name: string): boolean {
  return (
    name.startsWith(SUBMISSION_UPLOAD_DIRECTORY_PREFIX) &&
    SUBMISSION_UPLOAD_SUFFIX_PATTERN.test(name.slice(SUBMISSION_UPLOAD_DIRECTORY_PREFIX.length))
  );
}

const MANAGED_EXTENSIONS = new Set(ATTACHMENT_FILENAME_EXTENSIONS);
const TRASH_ENTRY_PATTERN = /^(\d{1,15})__(.+)$/u;

/**
 * Returns the attachment ID of a file name in the managed layout, or `null` for anything else
 * (staging directories, dotfiles, the trash directory, unknown extensions, nested paths).
 */
export function managedAttachmentIdFromFileName(fileName: string): string | null {
  if (
    fileName.length === 0 ||
    fileName.length > 255 ||
    fileName.startsWith(".") ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\0")
  ) {
    return null;
  }
  const attachmentId = parseAttachmentIdFromRelativePath(fileName);
  if (!attachmentId || parseThreadSegmentFromAttachmentId(attachmentId) === null) return null;
  return MANAGED_EXTENSIONS.has(fileName.slice(attachmentId.length)) ? attachmentId : null;
}

export function attachmentTrashEntryName(fileName: string, trashedAtMs: number): string {
  return `${Math.max(0, Math.floor(trashedAtMs))}__${fileName}`;
}

export interface AttachmentTrashEntry {
  readonly entryName: string;
  readonly fileName: string;
  readonly attachmentId: string;
  readonly trashedAtMs: number;
}

export function parseAttachmentTrashEntryName(entryName: string): AttachmentTrashEntry | null {
  const match = TRASH_ENTRY_PATTERN.exec(entryName);
  if (!match?.[1] || !match[2]) return null;
  const attachmentId = managedAttachmentIdFromFileName(match[2]);
  if (!attachmentId) return null;
  return { entryName, fileName: match[2], attachmentId, trashedAtMs: Number(match[1]) };
}

/** A file's age counts from its latest content or metadata change, whichever is newer. */
export function attachmentFileAgeMs(input: {
  readonly nowMs: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): number {
  return input.nowMs - Math.max(input.mtimeMs, input.ctimeMs);
}

export type AttachmentHoldReason = "referenced" | "staged" | "blocked" | "in-flight";

/**
 * Why each file must stay where it is. Bind two JSON arrays: attachment IDs, then file names.
 * Returns `(reason, key)` rows where `key` is an attachment ID or, for `in-flight`, a file name.
 *
 * - `referenced`: any projection reference row (live or soft-deleted thread), any active managed
 *   reference, an unresolved reference whose raw source text mentions the ID, an attachment of
 *   a queued prompt (`projection_threads.queued_prompts_json`), or an attachment of the message
 *   a pending turn start waits on (`pending_turn_start_json.messageId`). Queued prompts carry
 *   their attachments before any message row exists, so the reference tables cannot see them.
 *   Both read `projection_threads` once per query: rows with an empty queue or no pending start
 *   are skipped on the column value alone, and malformed JSON counts as empty, never as an error.
 * - `staged` / `blocked`: ownership that the staged-upload reconcile has not published.
 * - `in-flight`: a deletion pipeline or legacy purge job still owns the path.
 */
export const ATTACHMENT_HOLDS_SQL = `
  WITH ids(value) AS (SELECT value FROM json_each(?)),
    names(value) AS (SELECT value FROM json_each(?))
  SELECT 'referenced' AS reason, ref.attachment_id AS key
  FROM projection_thread_attachment_refs AS ref
  WHERE ref.attachment_id IN (SELECT value FROM ids)
  UNION ALL
  SELECT 'referenced', ref.attachment_id FROM managed_attachment_references AS ref
  WHERE ref.active = 1 AND ref.attachment_id IN (SELECT value FROM ids)
  UNION ALL
  SELECT DISTINCT 'referenced', ids.value
  FROM (
    SELECT COALESCE(message.attachments_json, activity.payload_json, '') AS text
    FROM projection_thread_attachment_refs AS unresolved
    LEFT JOIN projection_thread_messages AS message
      ON unresolved.source_kind = 'message' AND message.message_id = unresolved.source_id
    LEFT JOIN projection_thread_activities AS activity
      ON unresolved.source_kind = 'activity' AND activity.activity_id = unresolved.source_id
    WHERE unresolved.attachment_id = ''
  ) AS unresolved_source CROSS JOIN ids
  WHERE instr(unresolved_source.text, ids.value) > 0
  UNION ALL
  SELECT 'referenced', gated.attachment_id FROM (
    SELECT CASE WHEN attachment.type = 'object'
      THEN json_extract(attachment.value, '$.id') END AS attachment_id
    FROM projection_threads AS thread,
      json_each(CASE WHEN json_valid(thread.queued_prompts_json)
        THEN thread.queued_prompts_json ELSE '[]' END) AS prompt,
      json_each(CASE WHEN prompt.type = 'object'
          AND json_type(prompt.value, '$.attachments') = 'array'
        THEN json_extract(prompt.value, '$.attachments') ELSE '[]' END) AS attachment
    WHERE thread.queued_prompts_json IS NOT NULL AND thread.queued_prompts_json <> '[]'
    UNION ALL
    SELECT CASE WHEN attachment.type = 'object'
      THEN json_extract(attachment.value, '$.id') END
    FROM projection_threads AS thread
    JOIN projection_thread_messages AS message
      ON message.message_id = CASE WHEN json_valid(thread.pending_turn_start_json)
        THEN json_extract(thread.pending_turn_start_json, '$.messageId') END,
      json_each(CASE WHEN json_valid(message.attachments_json)
        THEN message.attachments_json ELSE '[]' END) AS attachment
    WHERE thread.pending_turn_start_json IS NOT NULL
  ) AS gated
  WHERE gated.attachment_id IN (SELECT value FROM ids)
  UNION ALL
  SELECT ownership.lifecycle, ownership.attachment_id FROM managed_attachment_ownership AS ownership
  WHERE ownership.lifecycle <> 'published' AND ownership.attachment_id IN (SELECT value FROM ids)
  UNION ALL
  SELECT 'in-flight', resource.relative_path FROM direct_resource_cleanup_resources AS resource
  WHERE resource.resource_kind = 'attachment' AND resource.terminal_at IS NULL
    AND resource.relative_path IN (SELECT value FROM names)
  UNION ALL
  SELECT 'in-flight', claim.relative_path FROM purge_resource_claims AS claim
  LEFT JOIN purge_jobs AS job ON job.job_id = claim.job_id
  WHERE claim.resource_kind = 'attachment' AND (job.status IS NULL OR job.status <> 'completed')
    AND claim.relative_path IN (SELECT value FROM names)
`;

export interface AttachmentHoldRow {
  readonly reason: string;
  readonly key: string;
}

export function attachmentHoldParams(
  files: ReadonlyArray<{ readonly attachmentId: string; readonly fileName: string }>,
): [string, string] {
  return [
    JSON.stringify(files.map((file) => file.attachmentId)),
    JSON.stringify(files.map((file) => file.fileName)),
  ];
}

/** Most protective hold per file; `undefined` when nothing holds it. */
export function indexAttachmentHolds(
  files: ReadonlyArray<{ readonly attachmentId: string; readonly fileName: string }>,
  rows: ReadonlyArray<AttachmentHoldRow>,
): Map<string, AttachmentHoldReason> {
  const byKey = new Map<string, AttachmentHoldReason>();
  for (const row of rows) {
    const reason = toHoldReason(row.reason);
    const existing = byKey.get(row.key);
    if (!existing || HOLD_PRIORITY[reason] < HOLD_PRIORITY[existing]) byKey.set(row.key, reason);
  }
  const holds = new Map<string, AttachmentHoldReason>();
  for (const file of files) {
    let hold: AttachmentHoldReason | undefined;
    for (const reason of [byKey.get(file.attachmentId), byKey.get(file.fileName)]) {
      if (reason && (!hold || HOLD_PRIORITY[reason] < HOLD_PRIORITY[hold])) hold = reason;
    }
    if (hold) holds.set(file.fileName, hold);
  }
  return holds;
}

const HOLD_PRIORITY: Record<AttachmentHoldReason, number> = {
  referenced: 0,
  "in-flight": 1,
  staged: 2,
  blocked: 3,
};

function toHoldReason(reason: string): AttachmentHoldReason {
  // Unknown lifecycles are treated like staged ones: never swept.
  return reason === "referenced" || reason === "in-flight" || reason === "blocked"
    ? reason
    : "staged";
}

/**
 * Backfill window: the next reference rows after the cursor, flagged when a live thread
 * references the ID and no ownership row exists. Bind cursor, then scan limit.
 */
export const ATTACHMENT_BACKFILL_WINDOW_SQL = `
  WITH scanned(attachment_id) AS (
    SELECT DISTINCT attachment_id FROM projection_thread_attachment_refs
    WHERE attachment_id > ? ORDER BY attachment_id LIMIT ?
  )
  SELECT scanned.attachment_id AS "attachmentId",
    (NOT EXISTS (
      SELECT 1 FROM managed_attachment_ownership AS ownership
      WHERE ownership.attachment_id = scanned.attachment_id
    ) AND EXISTS (
      SELECT 1 FROM projection_thread_attachment_refs AS ref
      JOIN projection_threads AS live ON live.thread_id = ref.thread_id
      WHERE ref.attachment_id = scanned.attachment_id AND live.deleted_at IS NULL
    )) AS "candidate"
  FROM scanned ORDER BY scanned.attachment_id
`;

/**
 * Read-only attachment maintenance facts for `database-size-report.ts`: how many files the
 * orphan sweep would trash, what the trash holds, and how many legacy files the ownership
 * backfill would cover. It classifies files with the server's own layout rules and SQL
 * (`attachmentMaintenance.layout.ts`), and only ever `lstat`s and lists the directory.
 */
import { existsSync, lstatSync, readdirSync, type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  ATTACHMENT_BACKFILL_WINDOW_SQL,
  ATTACHMENT_HOLD_CHUNK_SIZE,
  ATTACHMENT_HOLDS_SQL,
  ATTACHMENT_ORPHAN_GRACE_MS,
  ATTACHMENT_TRASH_DIRECTORY,
  ATTACHMENT_TRASH_RETENTION_MS,
  attachmentFileAgeMs,
  attachmentHoldParams,
  indexAttachmentHolds,
  managedAttachmentIdFromFileName,
  parseAttachmentTrashEntryName,
  type AttachmentHoldReason,
  type AttachmentHoldRow,
} from "../apps/server/src/attachments/attachmentMaintenance.layout.ts";

export interface FileTally {
  files: number;
  bytes: number;
}

export interface AttachmentMaintenanceFacts {
  /** Unreferenced, unheld and past the grace period: the next sweeps would trash these. */
  readonly orphans: FileTally;
  /** Unreferenced and unheld, but still inside the grace period. */
  readonly orphansInGrace: FileTally;
  /** Unreferenced but kept for a staged or blocked upload, or an in-flight deletion. */
  readonly held: FileTally & { readonly byReason: Partial<Record<AttachmentHoldReason, number>> };
  readonly referenced: FileTally;
  /** Directory entries outside the managed layout (staging directories, dotfiles, symlinks). */
  readonly unmanagedEntries: number;
  readonly trash: FileTally & { readonly due: FileTally; readonly referencedAgain: number };
  /** Referenced by a live thread with no ownership row: the backfill would record these. */
  readonly legacyBackfill: FileTally & { readonly missing: number; readonly ambiguous: number };
}

const REQUIRED_TABLES = [
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_attachment_refs",
  "managed_attachment_ownership",
  "managed_attachment_references",
  "direct_resource_cleanup_resources",
  "purge_resource_claims",
  "purge_jobs",
] as const;

const tally = (): FileTally => ({ files: 0, bytes: 0 });
const add = (target: FileTally, bytes: number) => {
  target.files += 1;
  target.bytes += bytes;
};

const lstatOrNull = (target: string): Stats | null => {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
};

const isRealDirectory = (directory: string) => {
  const stats = lstatOrNull(directory);
  return stats !== null && stats.isDirectory() && !stats.isSymbolicLink();
};

function holdsFor(
  db: DatabaseSync,
  files: ReadonlyArray<{ readonly attachmentId: string; readonly fileName: string }>,
): Map<string, AttachmentHoldReason> {
  const holds = new Map<string, AttachmentHoldReason>();
  const statement = db.prepare(ATTACHMENT_HOLDS_SQL);
  for (let index = 0; index < files.length; index += ATTACHMENT_HOLD_CHUNK_SIZE) {
    const chunk = files.slice(index, index + ATTACHMENT_HOLD_CHUNK_SIZE);
    const rows = statement.all(...attachmentHoldParams(chunk)) as unknown as AttachmentHoldRow[];
    for (const [fileName, reason] of indexAttachmentHolds(chunk, rows)) holds.set(fileName, reason);
  }
  return holds;
}

/** `null` when the directory or the attachment tables (migration 121) are missing. */
export function readAttachmentMaintenanceFacts(
  db: DatabaseSync,
  attachmentsDir: string,
  nowMs: number,
): AttachmentMaintenanceFacts | null {
  if (!existsSync(attachmentsDir) || !isRealDirectory(attachmentsDir)) return null;
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
  if (REQUIRED_TABLES.some((table) => !tables.has(table))) return null;

  let unmanagedEntries = 0;
  const managed: Array<{ attachmentId: string; fileName: string; stats: Stats }> = [];
  for (const fileName of readdirSync(attachmentsDir)) {
    const attachmentId = managedAttachmentIdFromFileName(fileName);
    const stats = attachmentId ? lstatOrNull(path.join(attachmentsDir, fileName)) : null;
    if (attachmentId && stats?.isFile() && !stats.isSymbolicLink()) {
      managed.push({ attachmentId, fileName, stats });
    } else if (fileName !== ATTACHMENT_TRASH_DIRECTORY) unmanagedEntries += 1;
  }

  const holds = holdsFor(db, managed);
  const orphans = tally();
  const orphansInGrace = tally();
  const referenced = tally();
  const held = { ...tally(), byReason: {} as Partial<Record<AttachmentHoldReason, number>> };
  for (const file of managed) {
    const hold = holds.get(file.fileName);
    const bytes = file.stats.size;
    if (hold === "referenced") add(referenced, bytes);
    else if (hold) {
      add(held, bytes);
      held.byReason[hold] = (held.byReason[hold] ?? 0) + 1;
    } else {
      const age = attachmentFileAgeMs({
        nowMs,
        mtimeMs: file.stats.mtimeMs,
        ctimeMs: file.stats.ctimeMs,
      });
      add(age >= ATTACHMENT_ORPHAN_GRACE_MS ? orphans : orphansInGrace, bytes);
    }
  }

  return {
    orphans,
    orphansInGrace,
    held,
    referenced,
    unmanagedEntries,
    trash: readTrash(db, path.join(attachmentsDir, ATTACHMENT_TRASH_DIRECTORY), nowMs),
    legacyBackfill: readLegacyBackfill(db, managed),
  };
}

function readTrash(db: DatabaseSync, trashDir: string, nowMs: number) {
  const trash = { ...tally(), due: tally(), referencedAgain: 0 };
  if (!isRealDirectory(trashDir)) return trash;
  const entries = readdirSync(trashDir).flatMap((name) => {
    const entry = parseAttachmentTrashEntryName(name);
    const stats = entry ? lstatOrNull(path.join(trashDir, name)) : null;
    return entry && stats?.isFile() && !stats.isSymbolicLink() ? [{ ...entry, stats }] : [];
  });
  const holds = holdsFor(db, entries);
  for (const entry of entries) {
    add(trash, entry.stats.size);
    const hold = holds.get(entry.fileName);
    if (hold === "referenced") trash.referencedAgain += 1;
    else if (!hold && nowMs - entry.trashedAtMs >= ATTACHMENT_TRASH_RETENTION_MS) {
      add(trash.due, entry.stats.size);
    }
  }
  return trash;
}

function readLegacyBackfill(
  db: DatabaseSync,
  managed: ReadonlyArray<{ attachmentId: string; stats: Stats }>,
) {
  const legacy = { ...tally(), missing: 0, ambiguous: 0 };
  const byId = new Map<string, Array<Stats>>();
  for (const file of managed)
    byId.set(file.attachmentId, [...(byId.get(file.attachmentId) ?? []), file.stats]);
  // No cursor and no scan limit: one read-only pass over every reference row.
  const rows = db.prepare(ATTACHMENT_BACKFILL_WINDOW_SQL).all("", -1) as Array<{
    attachmentId: string;
    candidate: number;
  }>;
  for (const row of rows) {
    if (Number(row.candidate) !== 1) continue;
    const files = byId.get(row.attachmentId) ?? [];
    if (files.length === 0) legacy.missing += 1;
    else if (files.length > 1) legacy.ambiguous += 1;
    else add(legacy, files[0]!.size);
  }
  return legacy;
}

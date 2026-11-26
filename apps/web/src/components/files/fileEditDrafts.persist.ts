import { backendScopedLocalStorage, onBackendStorageReady } from "../../lib/backendScopedStorage";
import {
  fileEditEntries,
  fileEditListeners,
  MAX_EDIT_BYTES,
  onFileEditDraftUpdated,
  updateFileEditDraft,
  type DraftEntry,
  type FileEditAttempt,
} from "./fileEditDrafts.state";

/**
 * Remote drafts the host has not acknowledged are kept locally for a short window so a reload or
 * restart does not lose them. Saved drafts are never stored; local files keep memory-only drafts.
 */
export const REMOTE_DRAFT_RETENTION_MS = 10 * 60 * 1000;
export const REMOTE_DRAFT_STORAGE_KEY = "bigbud:file-edit-drafts:v1";
export const NOT_KEPT_MESSAGE =
  "Not saved to host, and this draft couldn't be kept on this device. It will be lost if bigbud closes.";
const MAX_STORED_DRAFTS = 100;
const FLUSH_DELAY_MS = 500;

interface StoredDraft {
  readonly key: string;
  readonly cwd: string;
  readonly relativePath: string;
  readonly executionTargetId: string;
  readonly contents: string;
  readonly baseContents: string;
  readonly baseHash: string;
  /** The attempt's contents are omitted when they equal the draft, to avoid storing them twice. */
  readonly failure?: Omit<FileEditAttempt, "contents"> & { readonly contents?: string };
  readonly updatedAt: number;
}

const records = new Map<string, StoredDraft>();
const dirty = new Set<string>();
const touchedAt = new Map<string, number>();
let loaded = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const STRING_FIELDS = [
  "key",
  "cwd",
  "relativePath",
  "executionTargetId",
  "contents",
  "baseContents",
  "baseHash",
] as const;

function isStoredDraft(value: unknown): value is StoredDraft {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    STRING_FIELDS.every((field) => typeof record[field] === "string") &&
    typeof record.updatedAt === "number"
  );
}

function load(now: number): void {
  if (!loaded) {
    loaded = true;
    try {
      const raw = backendScopedLocalStorage.getItem(REMOTE_DRAFT_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      for (const record of Array.isArray(parsed) ? parsed : []) {
        if (isStoredDraft(record)) records.set(record.key, record);
      }
    } catch {
      // Unreadable storage holds nothing recoverable.
    }
  }
  for (const [key, record] of records) {
    if (now - record.updatedAt >= REMOTE_DRAFT_RETENTION_MS) {
      records.delete(key);
      dirty.add(key);
    }
  }
}

function unacknowledged(entry: DraftEntry): boolean {
  return entry.draft.remote && (entry.draft.status !== "saved" || entry.failure !== undefined);
}

/** A draft that cannot be stored keeps working in memory, with a visible warning. */
function warnNotKept(entry: DraftEntry): void {
  if (entry.draft.message === null && entry.draft.status !== "saved") {
    updateFileEditDraft(entry, { ...entry.draft, message: NOT_KEPT_MESSAGE });
  }
}

function toRecord(entry: DraftEntry, updatedAt: number): StoredDraft {
  const { failure } = entry;
  const storedFailure =
    failure && failure.contents === entry.draft.contents
      ? {
          baseHash: failure.baseHash,
          hash: failure.hash,
          operationId: failure.operationId,
          disposition: failure.disposition,
        }
      : failure;
  return {
    key: entry.key,
    cwd: entry.cwd,
    relativePath: entry.relativePath,
    executionTargetId: entry.executionTargetId ?? "",
    contents: entry.draft.contents,
    baseContents: entry.draft.baseContents,
    baseHash: entry.draft.baseHash,
    ...(storedFailure ? { failure: storedFailure } : {}),
    updatedAt,
  };
}

function tooLarge(contents: string): boolean {
  // Cheap bound first: UTF-8 never needs more than three bytes per UTF-16 code unit.
  return (
    contents.length * 3 > MAX_EDIT_BYTES &&
    new TextEncoder().encode(contents).byteLength > MAX_EDIT_BYTES
  );
}

function write(refused: DraftEntry[]): void {
  // On a full quota, drop the oldest records one at a time instead of losing every draft.
  const oldestFirst = [...records.values()].toSorted(
    (left, right) => left.updatedAt - right.updatedAt,
  );
  for (;;) {
    try {
      if (records.size) {
        const serialized = JSON.stringify([...records.values()]);
        backendScopedLocalStorage.setItem(REMOTE_DRAFT_STORAGE_KEY, serialized);
      } else {
        backendScopedLocalStorage.removeItem(REMOTE_DRAFT_STORAGE_KEY);
      }
      return;
    } catch {
      const oldest = oldestFirst.shift();
      if (!oldest) return;
      records.delete(oldest.key);
      const entry = fileEditEntries.get(oldest.key);
      if (entry) refused.push(entry);
    }
  }
}

/** Write changed remote drafts; acknowledged, expired or over-budget ones are removed. */
export function flushRemoteFileEditDrafts(now = Date.now()): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  load(now);
  if (dirty.size === 0) return;
  const refused: DraftEntry[] = [];
  for (const key of dirty) {
    const entry = fileEditEntries.get(key);
    const updatedAt = touchedAt.get(key) ?? now;
    if (!entry || !unacknowledged(entry) || now - updatedAt >= REMOTE_DRAFT_RETENTION_MS) {
      records.delete(key);
      continue;
    }
    if (
      tooLarge(entry.draft.contents) ||
      (!records.has(key) && records.size >= MAX_STORED_DRAFTS)
    ) {
      records.delete(key);
      refused.push(entry);
      continue;
    }
    records.set(key, toRecord(entry, updatedAt));
  }
  dirty.clear();
  write(refused);
  for (const entry of refused) warnNotKept(entry);
}

function scheduleFlush(entry: DraftEntry): void {
  if (!entry.draft.remote) return;
  // Only edits and save attempts extend the retention window; reads do not.
  if (entry.draft.status === "pending" || entry.draft.status === "saving") {
    touchedAt.set(entry.key, Date.now());
  }
  dirty.add(entry.key);
  if (flushTimer) return;
  flushTimer = setTimeout(() => flushRemoteFileEditDrafts(), FLUSH_DELAY_MS);
}

/** Recovered drafts cannot be saved until a fresh read of the host reconciles them. */
export function restoreRemoteFileEditDrafts(now = Date.now()): void {
  load(now);
  for (const record of records.values()) {
    if (fileEditEntries.has(record.key) || !record.executionTargetId) continue;
    touchedAt.set(record.key, record.updatedAt);
    const failure = record.failure
      ? { ...record.failure, contents: record.failure.contents ?? record.contents }
      : undefined;
    fileEditEntries.set(record.key, {
      key: record.key,
      cwd: record.cwd,
      relativePath: record.relativePath,
      executionTargetId: record.executionTargetId,
      draft: {
        contents: record.contents,
        baseContents: record.baseContents,
        baseHash: record.baseHash,
        status: "error",
        savedAt: null,
        message:
          "Recovered an unsaved draft. Checking the file on the host before it can be saved.",
        diskVerified: false,
        retryAllowed: false,
        verificationEpoch: 0,
        needsVerification: true,
        remote: true,
      },
      timer: null,
      writing: false,
      readDuringWrite: false,
      revision: 0,
      editingCount: 0,
      disk: { contents: record.baseContents, hash: record.baseHash },
      ...(failure ? { failure } : {}),
    });
    for (const listener of fileEditListeners.get(record.key) ?? []) listener();
  }
  // Expired records found by load() are physically removed from storage here.
  flushRemoteFileEditDrafts(now);
}

/** Remove stored drafts for a removed (forgotten) workspace. */
export function forgetStoredRemoteFileEditDrafts(cwd: string, executionTargetId: string): void {
  load(Date.now());
  for (const record of records.values()) {
    if (record.cwd === cwd && record.executionTargetId === executionTargetId) dirty.add(record.key);
  }
  for (const key of dirty) records.delete(key);
  flushRemoteFileEditDrafts();
}

/** Forget the in-memory mirror so the next access reloads from (possibly re-scoped) storage. */
export function resetRemoteFileEditDraftMirror(): void {
  records.clear();
  dirty.clear();
  touchedAt.clear();
  loaded = false;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

onFileEditDraftUpdated(scheduleFlush);

if (typeof window !== "undefined") {
  restoreRemoteFileEditDrafts();
  onBackendStorageReady(() => {
    // A bound window learns its storage scope late; reload the mirror from the scoped key.
    resetRemoteFileEditDraftMirror();
    restoreRemoteFileEditDrafts();
  });
  window.addEventListener("pagehide", () => flushRemoteFileEditDrafts());
}

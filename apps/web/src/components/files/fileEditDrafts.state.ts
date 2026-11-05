import type { ProjectWriteFileDisposition } from "@bigbud/contracts/workspace/project";

export const MAX_EDIT_BYTES = 512 * 1024;
export const SAVE_DELAY_MS = 650;
export const fileEditEncoder = new TextEncoder();

export type DraftStatus = "saved" | "pending" | "saving" | "error" | "conflict";
export type WriteDisposition = ProjectWriteFileDisposition;

export interface FileEditDraft {
  readonly contents: string;
  readonly baseContents: string;
  readonly baseHash: string;
  readonly status: DraftStatus;
  /** Timestamp of the most recent acknowledged write, not an initial read. */
  readonly savedAt: number | null;
  readonly message: string | null;
  readonly diskVerified: boolean;
  readonly retryAllowed: boolean;
  readonly verificationEpoch: number;
  readonly needsVerification: boolean;
}

export interface FileEditAttempt {
  readonly contents: string;
  readonly baseHash: string;
  readonly hash: string;
  readonly operationId: string;
  readonly disposition: WriteDisposition;
}

export interface DraftEntry {
  readonly key: string;
  readonly cwd: string;
  readonly relativePath: string;
  readonly executionTargetId?: string;
  draft: FileEditDraft;
  timer: ReturnType<typeof setTimeout> | null;
  writing: boolean;
  readDuringWrite: boolean;
  revision: number;
  editingCount: number;
  disk: { contents: string; hash: string };
  failure?: FileEditAttempt;
}

export const fileEditEntries = new Map<string, DraftEntry>();
export const fileEditListeners = new Map<string, Set<() => void>>();

/** Unresolved attempts are retired explicitly, never merely by displaying matching bytes. */
export function updateFileEditDraft(entry: DraftEntry, draft: FileEditDraft): void {
  entry.draft = draft;
  for (const listener of fileEditListeners.get(entry.key) ?? []) listener();
}

export function cancelFileEditTimer(entry: DraftEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
}

/** Reads must start in the current write epoch to verify a settled attempt. */
export function getFileEditReadEpoch(key: string): number {
  return fileEditEntries.get(key)?.draft.verificationEpoch ?? 0;
}

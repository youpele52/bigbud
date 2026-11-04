import { readNativeApi } from "../../rpc/nativeApi";

export const MAX_EDIT_BYTES = 512 * 1024;
const SAVE_DELAY_MS = 650;

export type DraftStatus = "saved" | "pending" | "saving" | "error" | "conflict";

export interface FileEditDraft {
  readonly contents: string;
  readonly baseContents: string;
  readonly baseHash: string;
  readonly status: DraftStatus;
  /** Timestamp of the most recent acknowledged write, not an initial read. */
  readonly savedAt: number | null;
  readonly message: string | null;
  readonly diskVerified: boolean;
}

interface DraftEntry {
  readonly key: string;
  readonly cwd: string;
  readonly relativePath: string;
  readonly executionTargetId?: string;
  draft: FileEditDraft;
  timer: ReturnType<typeof setTimeout> | null;
  writing: boolean;
  revision: number;
  editingCount: number;
  disk: { contents: string; hash: string };
  uncertain?: { contents: string; baseHash: string; operationId: string };
}

const entries = new Map<string, DraftEntry>();
const listeners = new Map<string, Set<() => void>>();
const encoder = new TextEncoder();

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if ([...entries.values()].some((entry) => entry.draft.status !== "saved")) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

export function fileEditKey(cwd: string, relativePath: string, executionTargetId?: string): string {
  return JSON.stringify([executionTargetId ?? null, cwd, relativePath]);
}

export function getFileEditDraft(key: string): FileEditDraft | null {
  return entries.get(key)?.draft ?? null;
}

export function subscribeFileEditDraft(key: string, listener: () => void): () => void {
  const subscribers = listeners.get(key) ?? new Set<() => void>();
  listeners.set(key, subscribers);
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(key);
  };
}

function update(entry: DraftEntry, draft: FileEditDraft) {
  if (draft.status === "saved") delete entry.uncertain;
  entry.draft = draft;
  for (const listener of listeners.get(entry.key) ?? []) listener();
}

function trimSavedDrafts() {
  if (entries.size <= 100) return;
  for (const [key, entry] of entries) {
    if (entries.size <= 100) break;
    if (entry.draft.status === "saved" && !entry.writing && !listeners.has(key))
      entries.delete(key);
  }
}

function schedule(entry: DraftEntry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void save(entry);
  }, SAVE_DELAY_MS);
}

async function sha256(contents: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(contents));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function save(entry: DraftEntry) {
  if (entry.writing || entry.draft.status !== "pending") return;
  const { contents, baseHash } = entry.draft;
  const operationId =
    entry.uncertain?.contents === contents && entry.uncertain.baseHash === baseHash
      ? entry.uncertain.operationId
      : `file-edit-${crypto.randomUUID()}`;
  const revision = entry.revision;
  if (encoder.encode(contents).byteLength > MAX_EDIT_BYTES) {
    update(entry, {
      ...entry.draft,
      status: "error",
      message: "Draft exceeds the 512 KiB edit limit. Reduce it before retrying.",
    });
    return;
  }
  entry.writing = true;
  update(entry, { ...entry.draft, status: "saving", message: null });
  try {
    const api = readNativeApi();
    if (!api) throw new Error("Connection unavailable.");
    const nextHash = await sha256(contents);
    await api.projects.writeFile({
      cwd: entry.cwd,
      relativePath: entry.relativePath,
      ...(entry.executionTargetId ? { executionTargetId: entry.executionTargetId } : {}),
      contents,
      expectedSha256: baseHash,
      operationId,
    });
    const newer = entry.revision !== revision;
    update(entry, {
      ...entry.draft,
      baseContents: contents,
      baseHash: nextHash,
      status: newer ? "pending" : "saved",
      savedAt: newer ? null : Date.now(),
      message: null,
      diskVerified: false,
    });
  } catch (cause) {
    // A transport failure may mean the write succeeded. Never blindly retry it.
    entry.uncertain = { contents, baseHash, operationId };
    const detail = cause instanceof Error ? cause.message : String(cause);
    const conflict =
      (typeof cause === "object" &&
        cause !== null &&
        "conflict" in cause &&
        cause.conflict === true) ||
      /workspace file changed since it was read/i.test(detail);
    update(entry, {
      ...entry.draft,
      status: conflict ? "conflict" : "error",
      diskVerified: false,
      message: conflict
        ? "File changed on disk. Draft retained; refresh to inspect the latest version before resolving."
        : `${detail}. Draft retained; verify the file before retrying.`,
    });
  } finally {
    entry.writing = false;
    if (entry.draft.status === "pending") schedule(entry);
  }
}

export function observeFileEditRead(input: {
  cwd: string;
  relativePath: string;
  executionTargetId?: string;
  contents: string;
  sha256: string;
}) {
  const key = fileEditKey(input.cwd, input.relativePath, input.executionTargetId);
  const entry = entries.get(key);
  if (!entry) {
    entries.set(key, {
      key,
      cwd: input.cwd,
      relativePath: input.relativePath,
      ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
      draft: {
        contents: input.contents,
        baseContents: input.contents,
        baseHash: input.sha256,
        status: "saved",
        savedAt: null,
        message: null,
        diskVerified: false,
      },
      timer: null,
      writing: false,
      revision: 0,
      editingCount: 0,
      disk: { contents: input.contents, hash: input.sha256 },
    });
    for (const listener of listeners.get(key) ?? []) listener();
    trimSavedDrafts();
    return;
  }
  if (entry.writing) return;
  entry.disk = { contents: input.contents, hash: input.sha256 };
  if (entry.editingCount > 0 && entry.draft.baseHash !== input.sha256) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    update(entry, {
      ...entry.draft,
      status: "conflict",
      message:
        "File changed on disk while editing. Your draft is retained; review before discarding it.",
      diskVerified: true,
    });
    return;
  }
  if (entry.draft.contents === input.contents) {
    update(entry, {
      contents: input.contents,
      baseContents: input.contents,
      baseHash: input.sha256,
      status: "saved",
      savedAt: entry.draft.baseHash === input.sha256 ? entry.draft.savedAt : null,
      message: null,
      diskVerified: false,
    });
  } else if (entry.draft.status === "saved") {
    update(entry, {
      contents: input.contents,
      baseContents: input.contents,
      baseHash: input.sha256,
      status: "saved",
      savedAt: null,
      message: null,
      diskVerified: false,
    });
  } else if (entry.draft.baseHash !== input.sha256) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    update(entry, {
      ...entry.draft,
      status: "conflict",
      message:
        "File changed on disk. Your draft is retained; copy it before resolving the conflict.",
      diskVerified: true,
    });
  } else if (entry.draft.status === "conflict" && !entry.draft.diskVerified) {
    update(entry, {
      ...entry.draft,
      status: "error",
      message:
        "The file still matches the original version. Review and retry if you want to save your draft.",
    });
  }
}

export function changeFileEditDraft(key: string, contents: string) {
  const entry = entries.get(key);
  if (!entry) return;
  entry.revision++;
  const status =
    entry.draft.status === "conflict" || entry.draft.status === "error"
      ? entry.draft.status
      : entry.writing
        ? "saving"
        : contents === entry.draft.baseContents
          ? "saved"
          : "pending";
  update(entry, {
    ...entry.draft,
    contents,
    status,
    savedAt: status === "saved" ? entry.draft.savedAt : null,
  });
  if (status === "pending") schedule(entry);
  else if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

export function retryFileEditDraft(key: string) {
  const entry = entries.get(key);
  if (!entry || entry.writing || entry.draft.status !== "error") return;
  update(entry, { ...entry.draft, status: "pending", message: null });
  schedule(entry);
}

export function discardConflictedFileEditDraft(key: string) {
  const entry = entries.get(key);
  if (
    !entry ||
    entry.writing ||
    entry.editingCount > 0 ||
    entry.draft.status !== "conflict" ||
    !entry.draft.diskVerified
  )
    return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  update(entry, {
    contents: entry.disk.contents,
    baseContents: entry.disk.contents,
    baseHash: entry.disk.hash,
    status: "saved",
    savedAt: null,
    message: null,
    diskVerified: false,
  });
}

export function trackFileEditSession(key: string): () => void {
  const entry = entries.get(key);
  if (!entry) return () => {};
  entry.editingCount++;
  return () => {
    entry.editingCount--;
  };
}

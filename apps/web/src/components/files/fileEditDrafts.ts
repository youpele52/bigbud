import {
  cancelFileEditTimer,
  fileEditEncoder,
  fileEditEntries as entries,
  fileEditListeners as listeners,
  updateFileEditDraft as update,
  MAX_EDIT_BYTES,
  type FileEditDraft,
} from "./fileEditDrafts.state";
import { scheduleFileEditSave as schedule } from "./fileEditDrafts.write";

export { MAX_EDIT_BYTES, getFileEditReadEpoch } from "./fileEditDrafts.state";
export type { FileEditDraft, DraftStatus } from "./fileEditDrafts.state";

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

/** Failed or incomplete reads cannot authorize recovery from an older disk snapshot. */
export function invalidateFileEditRead(key: string): void {
  const entry = entries.get(key);
  if (
    !entry ||
    (!entry.draft.diskVerified && !entry.draft.needsVerification && !entry.draft.retryAllowed)
  )
    return;
  update(entry, {
    ...entry.draft,
    diskVerified: false,
    needsVerification: false,
    retryAllowed: entry.failure?.disposition === "not-dispatched",
  });
}

function trimSavedDrafts(): void {
  if (entries.size <= 100) return;
  for (const [key, entry] of entries) {
    if (entries.size <= 100) break;
    if (entry.draft.status === "saved" && !entry.writing && !listeners.has(key))
      entries.delete(key);
  }
}

/** Observe only complete, hash-verified reads; oversized files may still resolve retained drafts. */
export function observeFileEditRead(input: {
  cwd: string;
  relativePath: string;
  executionTargetId?: string;
  contents: string;
  sha256: string;
  readEpoch?: number;
}) {
  const key = fileEditKey(input.cwd, input.relativePath, input.executionTargetId);
  const entry = entries.get(key);
  if (!entry) {
    if (fileEditEncoder.encode(input.contents).byteLength > MAX_EDIT_BYTES) return;
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
        retryAllowed: false,
        verificationEpoch: 0,
        needsVerification: false,
      },
      timer: null,
      writing: false,
      readDuringWrite: false,
      revision: 0,
      editingCount: 0,
      disk: { contents: input.contents, hash: input.sha256 },
    });
    for (const listener of listeners.get(key) ?? []) listener();
    trimSavedDrafts();
    return;
  }
  if (entry.writing) {
    entry.readDuringWrite = true;
    return;
  }
  if (input.readEpoch !== undefined && input.readEpoch !== entry.draft.verificationEpoch) {
    if (!entry.draft.needsVerification) update(entry, { ...entry.draft, needsVerification: true });
    return;
  }
  entry.disk = { contents: input.contents, hash: input.sha256 };
  const verified = { ...entry.draft, needsVerification: false };
  if (entry.failure?.disposition === "unknown") {
    update(entry, { ...verified, status: "error", retryAllowed: false, diskVerified: false });
    return;
  }
  if (
    entry.failure &&
    input.sha256 === entry.failure.hash &&
    input.contents === entry.failure.contents
  ) {
    const attempted = entry.failure;
    delete entry.failure;
    const newer = entry.draft.contents !== attempted.contents;
    update(entry, {
      ...verified,
      baseContents: attempted.contents,
      baseHash: input.sha256,
      status: newer ? "error" : "saved",
      retryAllowed: newer,
      message: newer
        ? "Previous save is on disk. Review and retry to save your newer draft."
        : null,
    });
    return;
  }
  if (entry.draft.contents === input.contents) {
    delete entry.failure;
    update(entry, {
      ...verified,
      baseContents: input.contents,
      baseHash: input.sha256,
      status: "saved",
      savedAt: entry.draft.baseHash === input.sha256 ? entry.draft.savedAt : null,
      retryAllowed: false,
      diskVerified: false,
      message: null,
    });
  } else if (
    entry.draft.baseHash !== input.sha256 &&
    (entry.editingCount > 0 || entry.draft.status !== "saved")
  ) {
    cancelFileEditTimer(entry);
    update(entry, {
      ...verified,
      status: "conflict",
      retryAllowed: false,
      message: "File changed on disk. Your draft is retained; review before discarding it.",
      diskVerified: true,
    });
  } else if (entry.draft.status === "saved") {
    update(entry, {
      ...verified,
      contents: input.contents,
      baseContents: input.contents,
      baseHash: input.sha256,
      savedAt: null,
      message: null,
      diskVerified: false,
    });
  } else if (entry.failure || entry.draft.status === "conflict" || entry.draft.status === "error") {
    update(entry, {
      ...verified,
      status: "error",
      retryAllowed: true,
      diskVerified: true,
      message: "The file still matches the original version. Review and retry to save your draft.",
    });
  } else if (entry.draft.needsVerification) {
    update(entry, verified);
  }
}

export function changeFileEditDraft(key: string, contents: string) {
  const entry = entries.get(key);
  if (!entry) return;
  entry.revision++;
  const status =
    entry.failure || entry.draft.status === "conflict" || entry.draft.status === "error"
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
  else cancelFileEditTimer(entry);
}

/** Only finished attempts may be retired; unknown execution cannot be retried even after edits. */
export function retryFileEditDraft(key: string) {
  const entry = entries.get(key);
  if (
    !entry ||
    entry.writing ||
    entry.draft.status !== "error" ||
    !entry.draft.retryAllowed ||
    entry.failure?.disposition === "unknown"
  )
    return;
  delete entry.failure;
  update(entry, { ...entry.draft, status: "pending", retryAllowed: false, message: null });
  schedule(entry);
}

export function discardConflictedFileEditDraft(key: string) {
  const entry = entries.get(key);
  if (
    !entry ||
    entry.writing ||
    entry.editingCount > 0 ||
    entry.draft.status !== "conflict" ||
    !entry.draft.diskVerified ||
    entry.failure?.disposition === "unknown"
  )
    return;
  cancelFileEditTimer(entry);
  delete entry.failure;
  update(entry, {
    ...entry.draft,
    contents: entry.disk.contents,
    baseContents: entry.disk.contents,
    baseHash: entry.disk.hash,
    status: "saved",
    savedAt: null,
    message: null,
    diskVerified: false,
    retryAllowed: false,
    needsVerification: false,
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

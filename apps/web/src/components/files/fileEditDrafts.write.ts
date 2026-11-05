import { readNativeApi } from "../../rpc/nativeApi";
import {
  cancelFileEditTimer,
  fileEditEncoder,
  MAX_EDIT_BYTES,
  SAVE_DELAY_MS,
  updateFileEditDraft as update,
  type DraftEntry,
  type WriteDisposition,
} from "./fileEditDrafts.state";

export function scheduleFileEditSave(entry: DraftEntry): void {
  cancelFileEditTimer(entry);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void save(entry);
  }, SAVE_DELAY_MS);
}

function writeDisposition(cause: unknown): WriteDisposition {
  if (typeof cause !== "object" || cause === null || !("writeDisposition" in cause))
    return "unknown";
  return cause.writeDisposition === "terminal" || cause.writeDisposition === "not-dispatched"
    ? cause.writeDisposition
    : "unknown";
}

async function sha256(contents: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", fileEditEncoder.encode(contents));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function save(entry: DraftEntry): Promise<void> {
  if (entry.writing || entry.failure || entry.draft.status !== "pending") return;
  const { contents, baseHash } = entry.draft;
  const operationId = `file-edit-${crypto.randomUUID()}`;
  const revision = entry.revision;
  if (fileEditEncoder.encode(contents).byteLength > MAX_EDIT_BYTES) {
    update(entry, {
      ...entry.draft,
      status: "error",
      retryAllowed: true,
      message: "Draft exceeds the 512 KiB edit limit. Reduce it before retrying.",
    });
    return;
  }
  entry.writing = true;
  entry.readDuringWrite = false;
  update(entry, {
    ...entry.draft,
    status: "saving",
    message: null,
    retryAllowed: false,
    diskVerified: false,
    needsVerification: false,
    verificationEpoch: entry.draft.verificationEpoch + 1,
  });
  let dispatched = false;
  let nextHash = baseHash;
  try {
    const api = readNativeApi();
    if (!api) throw new Error("Connection unavailable.");
    nextHash = await sha256(contents);
    dispatched = true;
    await api.projects.writeFile({
      cwd: entry.cwd,
      relativePath: entry.relativePath,
      ...(entry.executionTargetId ? { executionTargetId: entry.executionTargetId } : {}),
      contents,
      expectedSha256: baseHash,
      operationId,
    });
    const newer = entry.revision !== revision;
    entry.writing = false;
    update(entry, {
      ...entry.draft,
      baseContents: contents,
      baseHash: nextHash,
      status: newer ? "pending" : "saved",
      savedAt: newer ? null : Date.now(),
      message: null,
      needsVerification: entry.readDuringWrite,
      verificationEpoch: entry.draft.verificationEpoch + 1,
    });
  } catch (cause) {
    const disposition = dispatched ? writeDisposition(cause) : "not-dispatched";
    entry.failure = { contents, baseHash, hash: nextHash, operationId, disposition };
    const detail = cause instanceof Error ? cause.message : String(cause);
    const conflict =
      (typeof cause === "object" &&
        cause !== null &&
        "conflict" in cause &&
        cause.conflict === true) ||
      /workspace file changed since it was read/i.test(detail);
    entry.writing = false;
    update(entry, {
      ...entry.draft,
      status: disposition === "unknown" ? "error" : conflict ? "conflict" : "error",
      retryAllowed: disposition === "not-dispatched",
      diskVerified: false,
      needsVerification: true,
      verificationEpoch: entry.draft.verificationEpoch + 1,
      message:
        disposition === "unknown"
          ? `${detail}. Save outcome unknown; draft retained. Further saves are blocked because the original write may still finish.`
          : conflict
            ? "File changed on disk. Draft retained; refresh to inspect the latest version before resolving."
            : `${detail}. Draft retained; verify the file before retrying.`,
    });
  } finally {
    entry.writing = false;
    if (entry.draft.status === "pending") scheduleFileEditSave(entry);
  }
}

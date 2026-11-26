import { randomBytes } from "node:crypto";
import { rename } from "node:fs/promises";
import path from "node:path";
import { captureV2OperationAuthority, type V2OperationAuthority } from "./Client.guard.ts";
import { ensureV2ThreadPrivateChild, v2ThreadPrivateDirectory } from "./Orchestration.storage.ts";

const recovered = new Map<string, Promise<void>>();

/**
 * A state directory has one backend owner (`backend.lock`), so legacy per-record lock files are
 * stale in this process. Move the whole namespace aside once per root instead of reclaiming
 * individual inodes; new record writes serialize in-process. Evidence is retained, never deleted.
 */
export function quarantineV2RecordLocks(root: string, extra?: V2OperationAuthority): Promise<void> {
  const key = path.resolve(root);
  let pending = recovered.get(key);
  if (!pending) {
    pending = recover(root, extra).catch(() => undefined);
    recovered.set(key, pending);
  }
  return pending;
}

async function recover(root: string, extra?: V2OperationAuthority): Promise<void> {
  const authority = captureV2OperationAuthority(extra);
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  const source = path.join(root, "record-locks");
  try {
    await v2ThreadPrivateDirectory(source);
  } catch {
    // Absent or not our private namespace: the in-process writer never reads it.
    return;
  }
  const staleRoot = await ensureV2ThreadPrivateChild(root, "stale-record-locks", authority);
  const destination = path.join(
    staleRoot,
    `record-locks-${Date.now()}-${randomBytes(8).toString("hex")}`,
  );
  try {
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    await rename(source, destination);
  } catch {
    // Leaving a legacy directory in place is harmless: the new writer does not inspect it.
  }
}

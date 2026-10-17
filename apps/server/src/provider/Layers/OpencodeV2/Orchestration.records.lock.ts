import { createHash, createPublicKey } from "node:crypto";
import path from "node:path";
import { ensureV2ThreadPrivateChild } from "./Orchestration.storage.ts";
import { v2NativePluginDirectory } from "./PluginSetup.fs.ts";
import { acquireV2PluginPublicationLock } from "./PluginSetup.lock.ts";
import { captureV2OperationAuthority, type V2OperationAuthority } from "./Client.guard.ts";

/** Exact per-record app-private writer ownership; this does not claim a native admission fence. */
export async function lockV2ThreadRecord(
  namespace: string,
  key: string,
  privateKey: string,
  publicKey: string,
  extra?: V2OperationAuthority,
) {
  const authority = captureV2OperationAuthority(extra);
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  const root = await ensureV2ThreadPrivateChild(path.dirname(namespace), "record-locks", authority);
  const name = createHash("sha256")
    .update(JSON.stringify([namespace, key]))
    .digest("hex");
  const directory = await ensureV2ThreadPrivateChild(root, name, authority);
  const issuer = createHash("sha256")
    .update(createPublicKey(publicKey).export({ type: "spki", format: "der" }))
    .digest("hex");
  return acquireV2PluginPublicationLock(
    directory,
    await v2NativePluginDirectory(directory),
    JSON.stringify([namespace, key]),
    { issuer, privateKey, publicKey },
    authority,
  );
}

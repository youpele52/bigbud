import { constants } from "node:fs";
import { lstat, realpath, open, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { assertV2ThreadStorageAncestors } from "./Orchestration.storage.ancestors.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import {
  windowsDirectory,
  windowsRead,
  windowsMkdir,
  windowsRemove,
  type V2WindowsFileIdentity,
} from "./NativeFiles.windows.ts";

export interface V2PosixFileIdentity {
  readonly dev: number;
  readonly ino: number;
}
export type V2PluginFileIdentity = V2PosixFileIdentity | V2WindowsFileIdentity;
const same = (left: V2PluginFileIdentity, right: V2PluginFileIdentity) =>
  left.dev === right.dev && left.ino === right.ino;

/** User-readable 0755 native directories are safe; foreign writes/links and Windows guesswork are not. */
export async function v2NativePluginDirectory(
  directory: string,
  expected?: V2PluginFileIdentity,
): Promise<V2PluginFileIdentity> {
  if (process.platform === "win32") {
    if (expected && (typeof expected.dev !== "string" || typeof expected.ino !== "string"))
      throw new Error("V2 native Windows directory identity namespace changed.");
    return windowsDirectory(directory, false, expected as V2WindowsFileIdentity | undefined);
  }
  await assertV2ThreadStorageAncestors(directory);
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    Boolean(info.mode & 0o022) ||
    !Number.isSafeInteger(info.dev) ||
    !Number.isSafeInteger(info.ino) ||
    (await realpath(directory)) !== path.resolve(directory) ||
    (expected && !same(info, expected))
  )
    throw new Error(
      "V2 native plugin configuration directory is unsafe or changed; no permission repair.",
    );
  return { dev: info.dev, ino: info.ino };
}

/** Missing sources are distinct from rejected sources; callers must not reinterpret invalid files as absent. */
export async function readV2NativePluginFile(
  filename: string,
  privateOnly: boolean,
  maxBytes = 1048576,
) {
  if (process.platform === "win32") {
    try {
      return await windowsRead(filename, privateOnly, maxBytes);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  await v2NativePluginDirectory(path.dirname(filename));
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      Boolean(before.mode & (privateOnly ? 0o077 : 0o022)) ||
      before.size > maxBytes
    )
      throw new Error(
        "V2 native plugin configuration file is not a bounded, singly linked owner file.",
      );
    const buffer = Buffer.alloc(Math.min(maxBytes, before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const chunk = await handle.read(buffer, length, buffer.length - length, length);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat();
    const named = await lstat(filename);
    if (
      !same(before, after) ||
      !same(before, named) ||
      named.isSymbolicLink() ||
      length > maxBytes ||
      before.size !== bytes.length ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink
    )
      throw new Error("V2 native plugin configuration file changed during its read.");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { content, identity: { dev: before.dev, ino: before.ino } };
  } finally {
    await handle.close();
  }
}

/** Cross-profile directory coordination uses atomic mkdir/EEXIST plus root/child attestation.
 * Slots are disjoint: no profile owns this shared child and no retained slot lock gates its creation. */
export async function ensureV2NativePluginsDirectory(
  root: string,
  identity: V2PluginFileIdentity,
  authority: V2PluginSetupAuthority,
) {
  await v2NativePluginDirectory(root, identity);
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  const directory = path.join(root, "plugins");
  if (process.platform === "win32") {
    try {
      await windowsMkdir(
        root,
        "plugins",
        () => {
          authority.assertCurrent();
          authority.signal.throwIfAborted();
        },
        identity as V2WindowsFileIdentity,
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    authority.assertCurrent();
    await v2NativePluginDirectory(root, identity);
    return { directory, identity: await v2NativePluginDirectory(directory) };
  }
  const exists = await lstat(directory).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  if (!exists) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  await v2NativePluginDirectory(root, identity);
  return { directory, identity: await v2NativePluginDirectory(directory) };
}

/** Identity check for exclusive owned staging paths or an actively held writer lock. This is
 * not an atomic inode-conditional unlink and must never be used to reclaim another owner's lock. */
export async function removeV2NativePluginStaging(
  filename: string,
  identity: V2PluginFileIdentity,
  assertIssuance: () => void,
) {
  // First publication temporarily links this owned inode at staging and managed names.
  return removeV2OwnedFile(filename, identity, assertIssuance, 2);
}

/** Only exact-owned writer finalizers use this capability after their physical work settles.
 * It is never normal staging cleanup or exited-owner reclamation. */
export async function releaseV2OwnedPublicationLock(
  filename: string,
  identity: V2PluginFileIdentity,
) {
  if (!/^\.bigbud-thread-tools-(?:managed|[a-f0-9]{64})\.lock$/.test(path.basename(filename)))
    throw new Error("V2 owned lock finalizer path rejected.");
  return removeV2OwnedFile(filename, identity, () => {}, 1);
}

async function removeV2OwnedFile(
  filename: string,
  identity: V2PluginFileIdentity,
  assertIssuance: () => void,
  maxLinks: 1 | 2,
) {
  if (process.platform === "win32") {
    const owned = await windowsRead(filename, true).catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!owned) return;
    if (!same(owned.identity, identity))
      throw new Error("V2 native plugin staging successor preserved.");
    await windowsRemove(filename, owned, assertIssuance);
    return;
  }
  await v2NativePluginDirectory(path.dirname(filename));
  const observed = await lstat(filename).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!observed) return;
  if (
    observed.isSymbolicLink() ||
    !observed.isFile() ||
    observed.nlink < 1 ||
    observed.nlink > maxLinks ||
    Boolean(observed.mode & 0o077) ||
    !same(observed, identity) ||
    observed.uid !== process.getuid?.()
  )
    throw new Error("V2 native plugin staging successor preserved.");
  assertIssuance();
  await unlink(filename);
}

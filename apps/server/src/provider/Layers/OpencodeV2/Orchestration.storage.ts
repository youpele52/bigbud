import { constants } from "node:fs";
import { mkdir, lstat, open, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { createPublicKey, generateKeyPairSync, createHash } from "node:crypto";
import {
  windowsDirectory,
  windowsMkdir,
  windowsRead,
  windowsCreate,
  windowsList,
} from "./NativeFiles.windows.ts";
import { assertV2ThreadStorageAncestors } from "./Orchestration.storage.ancestors.ts";
import { openV2ThreadEncryptionKey } from "./Orchestration.storage.encryption.ts";
import { captureV2OperationAuthority, type V2OperationAuthority } from "./Client.guard.ts";

/** Never repair permissions or traverse a colliding symlink while exporting executable assets. */
export async function v2ThreadPrivateDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    await windowsDirectory(directory, true);
    return;
  }
  await assertV2ThreadStorageAncestors(directory);
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(directory)) !== path.resolve(directory) ||
    info.uid !== process.getuid?.() ||
    Boolean(info.mode & 0o077)
  )
    throw new Error("V2 thread-tools storage directory is not private/canonical.");
}

/** Inventory uses the same retained-handle namespace as private reads on Windows. */
export async function listV2ThreadPrivateDirectory(directory: string) {
  await v2ThreadPrivateDirectory(directory);
  return process.platform === "win32" ? windowsList(directory) : readdir(directory);
}

/** Exclusive child creation is preceded by parent validation, not recursive writes through links. */
export async function ensureV2ThreadPrivateChild(
  parent: string,
  name: string,
  extra?: V2OperationAuthority,
): Promise<string> {
  const authority = captureV2OperationAuthority(extra);
  await v2ThreadPrivateDirectory(parent);
  if (!/^[a-zA-Z0-9._-]+$/.test(name))
    throw new Error("V2 thread-tools storage child name rejected.");
  const directory = path.join(parent, name);
  authority.assertCurrent();
  try {
    if (process.platform === "win32") await windowsMkdir(parent, name, authority.assertCurrent);
    else await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await v2ThreadPrivateDirectory(directory);
  return directory;
}

/** Read only owner-private regular single-link files, including Windows ACL verification. */
export async function readV2ThreadPrivateFile(filename: string): Promise<string> {
  if (process.platform === "win32") {
    await v2ThreadPrivateDirectory(path.dirname(filename));
    return (await windowsRead(filename, true)).content;
  }
  await v2ThreadPrivateDirectory(path.dirname(filename));
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > 131072 ||
      before.uid !== process.getuid?.() ||
      Boolean(before.mode & 0o077)
    )
      throw new Error("V2 thread-tools storage file rejected.");
    const content = await handle.readFile("utf8");
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error("V2 thread-tools storage changed during read.");
    return content;
  } finally {
    await handle.close();
  }
}

/** New files never replace a same-path entry; creation is durable before capability use. */
export async function writeV2ThreadPrivateFile(
  filename: string,
  content: string,
  extra?: V2OperationAuthority,
): Promise<void> {
  const authority = captureV2OperationAuthority(extra);
  await v2ThreadPrivateDirectory(path.dirname(filename));
  authority.assertCurrent();
  if (process.platform === "win32") {
    await windowsCreate(filename, content, authority.assertCurrent);
    return;
  }
  const handle = await open(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    authority.assertCurrent();
    await handle.writeFile(content);
    authority.assertCurrent();
    await handle.sync();
  } finally {
    await handle.close();
  }
  await readV2ThreadPrivateFile(filename);
}

/** Persistent app signer exports only its public key to the native plugin. */
export async function openV2ThreadIssuer(stateDir: string) {
  const root = await ensureV2ThreadPrivateChild(stateDir, "opencode-v2-thread-tools");
  const directory = await ensureV2ThreadPrivateChild(root, "issuer");
  const filename = path.join(directory, "private.pem");
  let privateKey: string;
  try {
    privateKey = await readV2ThreadPrivateFile(filename);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const generated = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    try {
      await writeV2ThreadPrivateFile(filename, generated);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    privateKey = await readV2ThreadPrivateFile(filename);
  }
  const publicKey = createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== "ed25519")
    throw new Error("V2 thread-tools issuer algorithm rejected.");
  return {
    ...(await openV2ThreadEncryptionKey(directory)),
    root,
    privateKey,
    publicKey: publicKey.export({ type: "spki", format: "pem" }) as string,
    issuer: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
}

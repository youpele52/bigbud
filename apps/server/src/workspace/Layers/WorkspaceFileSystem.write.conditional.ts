import { createHash } from "node:crypto";
import {
  lstat,
  open,
  readFile as readFileBytes,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** The file on disk no longer matches the expected hash; nothing was written. */
export class ConditionalWriteConflict extends Error {
  constructor(readonly actualSha256: string | undefined) {
    super("Workspace file changed since it was read.");
  }
}

export interface ConditionalWriteResult {
  readonly resultSha256: string;
  readonly writeMode: "atomic" | "inPlace";
}

export async function currentSha256(absolutePath: string): Promise<string | undefined> {
  try {
    return sha256Hex(await readFileBytes(absolutePath));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A failure after an in-place truncate: the file may hold partial bytes; read back first. */
export class ConditionalWriteOutcomeUnknown extends Error {}

const isMissing = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

type Placement = "atomic" | "atomicRestoreGroup" | "inPlace";

/**
 * Replacing a hard-linked or foreign-owned file would split the link or change its owner, so
 * those are written in place (Zed's behaviour). A file the writer owns whose group alone differs
 * from the group a replacement would get (the directory's on macOS/BSD or a setgid directory,
 * otherwise the effective group) stays atomic and has its group restored on the replacement.
 */
function placement(
  file: { nlink: number; uid: number; gid: number },
  directory: { gid: number; mode: number },
): Placement {
  const uid = process.geteuid?.();
  const gid = process.getegid?.();
  if (file.nlink > 1 || (uid !== undefined && file.uid !== uid)) return "inPlace";
  const inheritsDirectoryGroup = process.platform !== "linux" || (directory.mode & 0o2000) !== 0;
  const replacementGid = inheritsDirectoryGroup ? directory.gid : gid;
  return replacementGid !== undefined && file.gid !== replacementGid
    ? "atomicRestoreGroup"
    : "atomic";
}

async function writeInPlace(
  absolutePath: string,
  bytes: Uint8Array,
  expectedSha256: string,
  identity: { dev: number; ino: number },
): Promise<string> {
  const handle = await open(absolutePath, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== identity.dev || opened.ino !== identity.ino) {
      throw new ConditionalWriteConflict(undefined);
    }
    const actual = sha256Hex(await handle.readFile());
    if (actual !== expectedSha256) throw new ConditionalWriteConflict(actual);
    try {
      await handle.truncate(0);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (bytesWritten <= 0) throw new Error("In-place write made no progress.");
        offset += bytesWritten;
      }
      await handle.sync();
      const read = Buffer.alloc(bytes.byteLength);
      await handle.read(read, 0, read.byteLength, 0);
      return sha256Hex(read);
    } catch (cause) {
      throw new ConditionalWriteOutcomeUnknown(
        `In-place write failed after the file was truncated: ${String(cause)}`,
      );
    }
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } catch {
    // Some platforms reject fsync on directories; the rename itself has completed.
  } finally {
    await directory.close();
  }
}

/**
 * Guarded local replacement. The hash is re-checked immediately before the rename (or in-place
 * write) so the window against other writers stays as small as possible; it is not zero.
 */
export async function replaceConditionalFile(
  workspaceRoot: string,
  absolutePath: string,
  contents: string,
  expectedSha256: string,
): Promise<ConditionalWriteResult> {
  try {
    return await replaceExisting(workspaceRoot, absolutePath, contents, expectedSha256);
  } catch (cause) {
    // Deleted after the pre-check: report the missing file as a conflict, not a failure.
    if (isMissing(cause)) throw new ConditionalWriteConflict(undefined);
    throw cause;
  }
}

async function replaceExisting(
  workspaceRoot: string,
  absolutePath: string,
  contents: string,
  expectedSha256: string,
): Promise<ConditionalWriteResult> {
  const root = await realpath(workspaceRoot);
  const resolved = await realpath(absolutePath);
  const withinRoot = relative(root, resolved);
  if (
    !withinRoot ||
    withinRoot === ".." ||
    withinRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinRoot)
  ) {
    throw new Error("Conditional editing is limited to files inside the workspace root.");
  }
  if ((await lstat(absolutePath)).isSymbolicLink()) {
    throw new Error("Conditional editing of symbolic links is not supported.");
  }
  const bytes = new TextEncoder().encode(contents);
  const original = await stat(absolutePath);
  let mode = placement(original, await stat(dirname(absolutePath)));
  const temporaryPath = join(dirname(absolutePath), `.bigbud-edit-${crypto.randomUUID()}`);
  try {
    if (mode !== "inPlace") {
      const temporary = await open(temporaryPath, "wx", original.mode & 0o777);
      try {
        await temporary.writeFile(bytes);
        if (mode === "atomicRestoreGroup") {
          // chown can fail when the writer is not in that group; fall back to in-place then.
          await temporary.chown(original.uid, original.gid).catch(() => {
            mode = "inPlace";
          });
        }
        await temporary.chmod(original.mode & 0o7777);
        await temporary.sync();
      } finally {
        await temporary.close();
      }
    }
    if (mode === "inPlace") {
      const resultSha256 = await writeInPlace(absolutePath, bytes, expectedSha256, original);
      return { resultSha256, writeMode: "inPlace" };
    }
    const resultSha256 = sha256Hex(await readFileBytes(temporaryPath));
    const actual = await currentSha256(absolutePath);
    if (actual !== expectedSha256) throw new ConditionalWriteConflict(actual);
    await rename(temporaryPath, absolutePath);
    await syncDirectory(dirname(absolutePath));
    return { resultSha256, writeMode: "atomic" };
  } finally {
    await unlink(temporaryPath).catch((cause: unknown) => {
      if (!isMissing(cause)) throw cause;
    });
  }
}

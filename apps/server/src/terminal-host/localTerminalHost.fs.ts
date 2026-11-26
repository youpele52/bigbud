import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, basename } from "node:path";

const MAX_BINARY_BYTES = 512 * 1024 * 1024;

export class LocalTerminalHostFileError extends Error {
  readonly _tag = "LocalTerminalHostFileError";
}

const currentUid = (): number | undefined => process.getuid?.();

/** Owned, non-symlink, `0700` directory. Never chmods or repairs a foreign path. */
export async function assertPrivateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new LocalTerminalHostFileError(`Not a private directory: ${directory}`);
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid)
    throw new LocalTerminalHostFileError(`Directory is owned by another user: ${directory}`);
  if ((stat.mode & 0o077) !== 0)
    throw new LocalTerminalHostFileError(`Directory is accessible by other users: ${directory}`);
}

/** Creates missing levels as `0700`; existing levels must already be private. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await assertPrivateDirectory(directory);
    return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // `recursive` may apply the umask; the leaf is ours, so tighten it explicitly.
  await fs.chmod(directory, 0o700);
  await assertPrivateDirectory(directory);
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some filesystems refuse directory fsync; the rename itself is still atomic.
  } finally {
    await handle?.close();
  }
}

/** Write-to-temp, fsync, chmod, rename, fsync parent. Readers never see a partial file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array, mode: number) {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(data);
    await handle.chmod(mode);
    await handle.sync();
  } catch (cause) {
    await handle.close();
    await fs.rm(temporary, { force: true });
    throw cause;
  }
  await handle.close();
  try {
    await fs.rename(temporary, path);
  } catch (cause) {
    await fs.rm(temporary, { force: true });
    throw cause;
  }
  await fsyncDirectory(directory);
}

/** Bounded sha256 of a regular file opened without following symlinks. */
export async function sha256File(path: string): Promise<string> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BINARY_BYTES)
      throw new LocalTerminalHostFileError(`Unsafe binary type or size: ${path}`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_BINARY_BYTES)
        throw new LocalTerminalHostFileError(`Binary grew during hashing: ${path}`);
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { withV2WindowsReadLease } from "../src/provider/Layers/OpencodeV2/NativeFiles.windows.lease.ts";
import { listV2ThreadPrivateDirectory } from "../src/provider/Layers/OpencodeV2/Orchestration.storage.ts";

/** Retain native Windows read/ancestor handles until the caller closes its SQLite snapshot. */
export async function withV2RecoveryBackup<T>(
  filename: string,
  expected: string | undefined,
  run: (digest: string, assertCurrent: () => void) => Promise<T>,
) {
  const names = await listV2ThreadPrivateDirectory(path.dirname(filename));
  if (
    ["-wal", "-shm", "-journal"].some((suffix) =>
      names.includes(`${path.basename(filename)}${suffix}`),
    )
  )
    throw new Error(
      "Recovery database backup contains live sidecar evidence; require a consistent standalone backup.",
    );
  if (process.platform === "win32")
    return withV2WindowsReadLease(filename, async (lease) => {
      if (lease.hash !== expected) throw new Error("Recovery database backup checksum changed.");
      await lease.verify();
      return run(lease.hash, lease.assertCurrent);
    });
  const before = await lstat(filename);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid?.() ||
    before.mode & 0o077
  )
    throw new Error("Recovery database backup is not private regular evidence.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  const digest = hash.digest("hex"),
    after = await lstat(filename);
  if (
    digest !== expected ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.size !== after.size
  )
    throw new Error("Recovery database backup checksum changed.");
  return run(digest, () => {});
}

import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { withV2WindowsReadLease } from "../src/provider/Layers/OpencodeV2/NativeFiles.windows.lease.ts";
import { listV2ThreadPrivateDirectory } from "../src/provider/Layers/OpencodeV2/Orchestration.storage.ts";

/** Retain native Windows read/ancestor handles until the caller closes its SQLite snapshot. */
export async function withV2RecoveryBackup<T>(
  filename: string,
  expected: string | undefined,
  run: (digest: string, assertCurrent: () => void) => Promise<T>,
  selectedStateDatabase?: string,
) {
  // Legacy preparation runs under Bun. Only the Node-based revalidation entrypoint
  // requests database association; do not eagerly load node:sqlite in legacy callers.
  const verified = async (digest: string, assertCurrent: () => void) => {
    if (!selectedStateDatabase) return run(digest, assertCurrent);
    const { withV2RecoveryDatabase } =
      await import("./prepareOpencodeV2RebootRecovery.database.ts");
    return withV2RecoveryDatabase(filename, selectedStateDatabase, assertCurrent, (guard) =>
      run(digest, guard),
    );
  };
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
      return verified(lease.hash, lease.assertCurrent);
    });
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077
    )
      throw new Error("Recovery database backup is not private regular evidence.");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const digest = hash.digest("hex");
    if (digest !== expected) throw new Error("Recovery database backup checksum changed.");
    const assertCurrent = () => {
      for (const current of [fstatSync(handle.fd), lstatSync(filename)]) {
        if (
          !current.isFile() ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          current.size !== before.size ||
          current.mtimeMs !== before.mtimeMs ||
          current.ctimeMs !== before.ctimeMs ||
          current.mode !== before.mode ||
          current.uid !== before.uid ||
          current.nlink !== 1
        )
          throw new Error("Recovery database backup identity/content changed before publication.");
      }
      if (["-wal", "-shm", "-journal"].some((suffix) => existsSync(`${filename}${suffix}`)))
        throw new Error("Recovery database backup gained live sidecar evidence.");
    };
    assertCurrent();
    return await verified(digest, assertCurrent);
  } finally {
    await handle.close();
  }
}

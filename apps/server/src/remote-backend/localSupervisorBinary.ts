import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import {
  validateRemoteAgentRuntime,
  type RemoteAgentRuntime,
} from "../remote-agent/remoteAgentRuntime.ts";

const MAX_BINARY_BYTES = 512 * 1024 * 1024;
export class LocalSupervisorBinaryError extends Error {
  readonly _tag = "LocalSupervisorBinaryError";
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o700 ||
    (await fs.realpath(directory)) !== directory
  )
    throw new LocalSupervisorBinaryError(
      "The installed supervisor directories must be canonical owned private directories.",
    );
}

/** Artifact-only check is private: it cannot admit a proxy or runtime. */
async function verifyStagedArtifact(value: RemoteAgentRuntime): Promise<RemoteAgentRuntime> {
  const runtime = validateRemoteAgentRuntime(value);
  if (runtime.origin !== "managed")
    throw new LocalSupervisorBinaryError("A managed local supervisor is required.");
  const root = dirname(dirname(runtime.statePath));
  for (const directory of [
    root,
    join(root, "bin"),
    join(root, "bin", runtime.version),
    dirname(runtime.binaryPath),
  ])
    await assertPrivateDirectory(directory);
  const handle = await fs.open(
    runtime.binaryPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o7777) !== 0o700 ||
      before.size < 1 ||
      before.size > MAX_BINARY_BYTES
    )
      throw new LocalSupervisorBinaryError(
        "The installed supervisor binary has unsafe ownership, permissions, type or size.",
      );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_BINARY_BYTES)
        throw new LocalSupervisorBinaryError(
          "The supervisor binary exceeded its bounded size during verification.",
        );
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const path = await fs.lstat(runtime.binaryPath);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      path.dev !== after.dev ||
      path.ino !== after.ino ||
      total !== after.size ||
      hash.digest("hex") !== runtime.sha256
    )
      throw new LocalSupervisorBinaryError(
        "The installed supervisor bytes changed or disagree with the pinned artifact.",
      );
  } finally {
    await handle.close();
  }
  return runtime;
}

/** Full runtime admission still requires BOTH the exact generation and verified installed bytes. */
export async function verifyManagedLocalSupervisor(value: RemoteAgentRuntime): Promise<void> {
  const runtime = validateRemoteAgentRuntime(value);
  if (runtime.origin !== "managed")
    throw new LocalSupervisorBinaryError("A managed local supervisor is required.");
  const root = dirname(dirname(runtime.statePath));
  for (const directory of [join(root, "runtimes"), runtime.statePath])
    await assertPrivateDirectory(directory);
  await verifyStagedArtifact(runtime);
}

/** Explicit signed-staging boundary; creates only the empty original generation, never launches.
 * Existing unsafe/foreign state is preserved. This is not a runtime admission capability. */
export async function prepareManagedLocalSupervisorRuntime(
  value: RemoteAgentRuntime,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const runtime = await verifyStagedArtifact(value);
  const root = dirname(dirname(runtime.statePath));
  const directories = [join(root, "runtimes"), runtime.statePath];
  // Inspect every existing path before the first creation; never chmod, follow or repair one.
  for (const directory of directories) {
    try {
      await assertPrivateDirectory(directory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  for (const directory of directories) {
    signal?.throwIfAborted();
    await assertPrivateDirectory(root);
    if (directory === runtime.statePath) await assertPrivateDirectory(directories[0]!);
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    await assertPrivateDirectory(directory);
  }
  const entries = await fs.opendir(runtime.statePath);
  for await (const _entry of entries)
    throw new LocalSupervisorBinaryError(
      "A staged runtime generation must be empty before first setup.",
    );
  signal?.throwIfAborted();
}

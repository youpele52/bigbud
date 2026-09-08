import * as nodeFs from "node:fs/promises";
import path from "node:path";

import type { RemoteAgentResourceCleanupIdentity } from "../../remote-agent/remoteAgentProtocol.resourceCleanup.ts";

function identity(stats: import("node:fs").BigIntStats): RemoteAgentResourceCleanupIdentity {
  const entryType = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : undefined;
  if (!entryType || stats.isSymbolicLink()) throw new Error("unsupported cleanup resource entry");
  return {
    deviceOrVolume: stats.dev.toString(10),
    inodeOrFileId: stats.ino.toString(10),
    entryType,
  };
}

async function captureIdentity(input: {
  readonly root: string;
  readonly relativePath: string;
}): Promise<{
  readonly identity?: RemoteAgentResourceCleanupIdentity;
  readonly rootIdentity: RemoteAgentResourceCleanupIdentity;
  readonly parentIdentity: RemoteAgentResourceCleanupIdentity;
}> {
  const rootStats = await nodeFs.lstat(input.root, { bigint: true });
  const target = path.resolve(input.root, input.relativePath);
  const parent = path.dirname(target);
  const parentStats = await nodeFs.lstat(parent, { bigint: true });
  let targetIdentity: RemoteAgentResourceCleanupIdentity | undefined;
  try {
    targetIdentity = identity(await nodeFs.lstat(target, { bigint: true }));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return {
    ...(targetIdentity ? { identity: targetIdentity } : {}),
    rootIdentity: identity(rootStats),
    parentIdentity: identity(parentStats),
  };
}

export async function captureDirectCleanupIdentity(
  input: Parameters<typeof captureIdentity>[0],
): ReturnType<typeof captureIdentity> {
  try {
    return await captureIdentity(input);
  } catch {
    throw new Error("direct cleanup identity capture failed");
  }
}

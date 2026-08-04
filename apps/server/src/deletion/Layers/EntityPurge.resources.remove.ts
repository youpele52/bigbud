import * as nodeFs from "node:fs/promises";
import path from "node:path";

import type { PurgeResourceIdentity } from "../../persistence/Services/PurgeJobRepository.ts";

export async function removeWithoutFollowingSymlinks(
  target: string,
  expected: Pick<PurgeResourceIdentity, "device" | "inode" | "type">,
): Promise<number> {
  const initial = await nodeFs.lstat(target);
  if (
    initial.isSymbolicLink() ||
    initial.dev !== expected.device ||
    initial.ino !== expected.inode ||
    (expected.type === "directory" ? !initial.isDirectory() : !initial.isFile())
  ) {
    throw new Error("purge resource identity changed during removal");
  }
  if (expected.type === "file") {
    await nodeFs.unlink(target);
    return initial.size;
  }
  let knownBytes = 0;
  const entries = await nodeFs.readdir(target);
  const afterRead = await nodeFs.lstat(target);
  if (
    afterRead.isSymbolicLink() ||
    afterRead.dev !== expected.device ||
    afterRead.ino !== expected.inode ||
    !afterRead.isDirectory()
  ) {
    throw new Error("purge directory changed during traversal");
  }
  for (const entry of entries) {
    const child = path.join(target, entry);
    const stats = await nodeFs.lstat(child);
    if (stats.isSymbolicLink() || stats.isFile()) {
      await nodeFs.unlink(child);
      if (stats.isFile()) knownBytes += stats.size;
      continue;
    }
    if (!stats.isDirectory()) throw new Error("unsupported entry in purge directory");
    knownBytes += await removeWithoutFollowingSymlinks(child, {
      device: stats.dev,
      inode: stats.ino,
      type: "directory",
    });
  }
  const beforeRemove = await nodeFs.lstat(target);
  if (
    beforeRemove.isSymbolicLink() ||
    beforeRemove.dev !== expected.device ||
    beforeRemove.ino !== expected.inode ||
    !beforeRemove.isDirectory()
  ) {
    throw new Error("purge directory changed before removal");
  }
  await nodeFs.rmdir(target);
  return knownBytes;
}

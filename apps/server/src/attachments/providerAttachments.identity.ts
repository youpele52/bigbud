import { lstat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";

/** Capture and recheck the permitted path and opened object, not merely its final symlink bit. */
export async function captureAttachmentIdentity(root: string, filename: string) {
  const names = [root];
  let current = root;
  for (const segment of path.relative(root, filename).split(path.sep)) {
    current = path.join(current, segment);
    names.push(current);
  }
  const entries: { name: string; info: Stats }[] = [];
  for (const name of names) {
    const info = await lstat(name);
    if (
      info.isSymbolicLink() ||
      (name === filename ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())
    )
      throw new Error("V2 media path identity rejected.");
    entries.push({ name, info });
  }
  const identity = entries.at(-1)!.info;
  return async (handle: FileHandle) => {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== identity.dev ||
      opened.ino !== identity.ino ||
      opened.size !== identity.size ||
      opened.mtimeMs !== identity.mtimeMs
    )
      throw new Error("V2 media opened object identity changed.");
    for (const { name, info } of entries) {
      const after = await lstat(name);
      if (
        after.isSymbolicLink() ||
        after.dev !== info.dev ||
        after.ino !== info.ino ||
        after.mode !== info.mode
      )
        throw new Error("V2 media intermediate path identity changed.");
    }
    return opened;
  };
}

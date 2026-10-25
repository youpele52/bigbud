import { lstat, realpath as privateRealpath, open, opendir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { inspectV2WindowsAcl } from "./ProfileIsolation.windows.mjs";

/** Shared local/SSH POSIX policy. Does not claim same-UID or cross-process filesystem atomicity. */
export async function inspectPrivateV2Profile(root, options = {}) {
  if (process.platform === "win32") {
    await inspectV2WindowsAcl(root, options.signal);
    if (options.application || options.marker !== false) {
      const marker = path.join(
        root,
        options.application ? ".bigbud-opencode-v2" : ".bigbud-opencode-v2-development",
      );
      const handle = await open(
        marker,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await handle.stat();
        const expected = options.application
          ? "bigbud-opencode-v2-owned-v1\n"
          : "bigbud-opencode-v2-disposable-v1\n";
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size !== Buffer.byteLength(expected) ||
          (await handle.readFile("utf8")) !== expected
        )
          throw new Error("V2 Windows ownership marker rejected.");
      } finally {
        await handle.close();
      }
    }
    return;
  }
  if (typeof process.getuid !== "function")
    throw new Error("V2 profile owner inspection unavailable.");
  const uid = process.getuid();
  const deadline = performance.now() + (options.timeoutMs ?? 5000);
  const check = () => {
    if (options.signal?.aborted || performance.now() >= deadline)
      throw new Error("V2 profile inspection cancelled or timed out.");
  };
  const inspect = async (filename, parent = false) => {
    check();
    const info = await lstat(filename);
    check();
    if (info.isSymbolicLink() || (info.uid !== uid && !(parent && info.uid === 0)))
      throw new Error("V2 profile links or owner rejected.");
    if (info.mode & 0o022 && !(parent && info.isDirectory() && info.mode & 0o1000))
      throw new Error("V2 profile writable access rejected.");
    if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
      throw new Error("V2 profile nonregular entry or hard links rejected.");
    return info;
  };
  check();
  if ((await privateRealpath(root)) !== path.resolve(root))
    throw new Error("V2 profile symlink traversal rejected.");
  check();
  const initial = await inspect(root);
  if (!initial.isDirectory() || initial.mode & 0o077)
    throw new Error("V2 profile root must be private to its owner.");
  for (let parent = path.dirname(root); ; parent = path.dirname(parent)) {
    const info = await inspect(parent, true);
    if (!info.isDirectory()) throw new Error("V2 profile parent is not a directory.");
    if (parent === path.dirname(parent)) break;
  }
  if (options.marker !== false) {
    let marker;
    try {
      check();
      marker = await open(
        path.join(
          root,
          options.application ? ".bigbud-opencode-v2" : ".bigbud-opencode-v2-development",
        ),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      check();
      const info = await marker.stat();
      if (
        !info.isFile() ||
        info.uid !== uid ||
        info.mode & 0o022 ||
        info.nlink !== 1 ||
        info.size > 128
      )
        throw new Error("V2 profile ownership marker is invalid.");
      const buffer = Buffer.alloc(129);
      const { bytesRead } = await marker.read(buffer, 0, buffer.length, 0);
      check();
      const after = await marker.stat();
      if (
        bytesRead !== info.size ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        buffer.subarray(0, bytesRead).toString("utf8").trim() !==
          (options.application ? "bigbud-opencode-v2-owned-v1" : "bigbud-opencode-v2-disposable-v1")
      )
        throw new Error("V2 profile ownership marker is invalid.");
    } finally {
      await marker?.close();
    }
  }
  const queue = [root];
  let entries = 0;
  while (queue.length) {
    check();
    const directory = queue.pop();
    const before = await inspect(directory);
    let handle;
    try {
      handle = await opendir(directory);
      check();
      const after = await inspect(directory);
      if (before.dev !== after.dev || before.ino !== after.ino)
        throw new Error("V2 profile directory replaced during inspection.");
      while (true) {
        check();
        const entry = await handle.read();
        check();
        if (!entry) break;
        if (++entries > (options.maxEntries ?? 10000))
          throw new Error("V2 profile ownership inspection bound exceeded.");
        const filename = path.join(directory, entry.name);
        const info = await inspect(filename);
        if (info.isDirectory()) queue.push(filename);
      }
    } finally {
      await handle?.close();
    }
  }
  const final = await inspect(root);
  if (initial.dev !== final.dev || initial.ino !== final.ino)
    throw new Error("V2 profile root replaced during inspection.");
  check();
}

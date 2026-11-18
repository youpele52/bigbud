import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { BackendGraphManifest, BackendGraphFile } from "./backendGraph.manifest.ts";
import { assertPrivateOwnership, type PrivatePathKind } from "./privatePermission.ts";

export interface BackendGraphRoot {
  readonly dev: string;
  readonly ino: string;
  readonly ctimeNs: string;
}
function same(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function owned(stat: BigIntStats, mode: number, path: string, kind: PrivatePathKind) {
  assertPrivateOwnership(stat, {
    kind,
    path,
    allowedModes: [mode],
    message: "Executable graph must be privately owned with exact safe permissions.",
    role: kind === "file" ? "executable graph file" : "executable graph directory (--graph-root)",
  });
}
async function verifyFile(
  path: string,
  member: BackendGraphFile,
  buffer: Buffer,
  signal?: AbortSignal,
) {
  const file = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    owned(before, member.executable ? 0o700 : 0o600, path, "file");
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(member.sizeBytes))
      throw new Error("Executable graph member type, link count or size does not match.");
    const hash = createHash("sha256");
    let offset = 0;
    while (offset <= member.sizeBytes) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, member.sizeBytes + 1 - offset),
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    const named = await fs.lstat(path, { bigint: true });
    if (
      offset !== member.sizeBytes ||
      !same(before, after) ||
      !same(after, named) ||
      hash.digest("hex") !== member.sha256
    )
      throw new Error("Executable graph member changed or failed digest verification.");
    return after;
  } finally {
    await file.close();
  }
}

/** Read-only verification of the entire private graph, including eager external/native files. */
export async function verifyBackendGraphDirectory(
  root: string,
  manifest: BackendGraphManifest,
  signal?: AbortSignal,
): Promise<BackendGraphRoot> {
  signal?.throwIfAborted();
  if (!isAbsolute(root) || normalize(root) !== root || (await fs.realpath(root)) !== root)
    throw new Error("Executable graph root must be absolute and canonical without links.");
  const wanted = new Map(manifest.files.map((file) => [file.path, file]));
  const expectedDirs = new Set<string>([""]);
  for (const { path } of manifest.files) {
    const parts = path.split("/");
    for (let n = 1; n < parts.length; n++) {
      expectedDirs.add(parts.slice(0, n).join("/"));
      if (expectedDirs.size > 32768)
        throw new Error("Executable graph exceeds its directory budget.");
    }
  }
  const directories = new Map<string, BigIntStats>();
  const buffer = Buffer.alloc(64 * 1024);
  const observed = new Map<string, BigIntStats>();
  async function visit(relative: string): Promise<void> {
    signal?.throwIfAborted();
    const path = relative ? join(root, relative) : root;
    const before = await fs.lstat(path, { bigint: true });
    if (!before.isDirectory())
      throw new Error("Executable graph directory must not contain links.");
    owned(before, 0o700, path, "directory");
    if ((await fs.realpath(path)) !== path)
      throw new Error("Executable graph directory must not contain links.");
    directories.set(path, before);
    // Stream entries so undeclared directory contents cannot force an unbounded allocation.
    for await (const entry of await fs.opendir(path)) {
      signal?.throwIfAborted();
      const name = entry.name;
      const child = relative ? `${relative}/${name}` : name;
      const childPath = join(root, child);
      const stat = await fs.lstat(childPath, { bigint: true });
      if (stat.isDirectory()) {
        if (!expectedDirs.has(child))
          throw new Error("Executable graph contains an undeclared directory.");
        await visit(child);
      } else {
        const member = wanted.get(child);
        if (!member) throw new Error("Executable graph contains an undeclared member.");
        observed.set(child, await verifyFile(childPath, member, buffer, signal));
      }
    }
  }
  await visit("");
  if (observed.size !== wanted.size) throw new Error("Executable graph is incomplete.");
  // A previously hashed file can change in-place without changing its parent directory.
  for (const [relative, before] of observed) {
    signal?.throwIfAborted();
    if (!same(before, await fs.lstat(join(root, relative), { bigint: true })))
      throw new Error("Executable graph member changed during verification.");
  }
  for (const [path, before] of directories) {
    signal?.throwIfAborted();
    if (!same(before, await fs.lstat(path, { bigint: true })) || (await fs.realpath(path)) !== path)
      throw new Error("Executable graph directory changed during verification.");
  }
  const stat = directories.get(root)!;
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  BACKEND_GRAPH_MAX_BYTES,
  BACKEND_GRAPH_MAX_FILES,
  isBackendGraphPath,
  type BackendGraphFile,
} from "../apps/server/src/remote-backend/backendGraph.manifest.ts";
import { fingerprint } from "./lib/artifact-build/io.ts";

/** Enumerate the whole private graph. The verifier repeats this scan after signing. */
export async function inventoryBackendGraph(root: string, signal?: AbortSignal) {
  const files: BackendGraphFile[] = [];
  let total = 0,
    directories = 0;
  const buffer = Buffer.alloc(64 * 1024);
  async function visit(directory: string, prefix: string, depth: number): Promise<void> {
    signal?.throwIfAborted();
    const info = await lstat(directory);
    if (
      ++directories > 32768 ||
      depth > 32 ||
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700 ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Graph directory must be private and canonical.");
    const entries = await opendir(directory);
    for await (const entry of entries) {
      signal?.throwIfAborted();
      const path = prefix + entry.name,
        absolute = join(root, path);
      if (
        !isBackendGraphPath(path) ||
        entry.name.startsWith(".env") ||
        [".git", ".npmrc", ".netrc", ".bigbud", ".config"].includes(entry.name)
      )
        throw new Error("Graph contains forbidden local state or an invalid member path.");
      const named = await lstat(absolute);
      if (named.isDirectory()) {
        await visit(absolute, path + "/", depth + 1);
        continue;
      }
      if (
        !named.isFile() ||
        named.nlink !== 1 ||
        named.uid !== process.getuid?.() ||
        ![0o600, 0o700].includes(named.mode & 0o777) ||
        files.length >= BACKEND_GRAPH_MAX_FILES
      )
        throw new Error("Graph member must be a bounded owned private regular file.");
      total += named.size;
      if (!Number.isSafeInteger(total) || total > BACKEND_GRAPH_MAX_BYTES)
        throw new Error("Graph exceeds byte budget.");
      const file = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const initial = await file.stat();
        if (fingerprint(initial) !== fingerprint(named))
          throw new Error("Graph changed while opening.");
        const hash = createHash("sha256");
        let offset = 0;
        let tail = "";
        while (true) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          if (offset > named.size) throw new Error("Graph member grew while hashing.");
          const text = tail + buffer.subarray(0, bytesRead).toString("latin1");
          if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]/.test(text))
            throw new Error("Executable graph must not contain private signing/SSH key material.");
          tail = text.slice(-80);
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (
          offset !== named.size ||
          fingerprint(await file.stat()) !== fingerprint(named) ||
          fingerprint(await lstat(absolute)) !== fingerprint(named) ||
          (await realpath(absolute)) !== absolute
        )
          throw new Error("Graph member changed while hashing.");
        files.push({
          path,
          sizeBytes: offset,
          sha256: hash.digest("hex"),
          executable: (named.mode & 0o100) !== 0,
        });
      } finally {
        await file.close();
      }
    }
    if (fingerprint(await lstat(directory)) !== fingerprint(info))
      throw new Error("Graph directory changed while scanning.");
  }
  await visit(root, "", 0);
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

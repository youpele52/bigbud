import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { hashFile, isWithin, type ClosureEntry } from "./closure.ts";

/** Filesystem proof only: this never starts the private runtime or contacts a provider. */
export async function verifyExtractedClosure(root: string, entries: readonly ClosureEntry[]) {
  const canonical = await realpath(root);
  const expected = new Map(entries.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  async function visit(parent: string): Promise<void> {
    for (const name of await readdir(join(canonical, parent))) {
      const path = parent ? `${parent}/${name}` : name;
      const entry = expected.get(path);
      if (!entry) throw new Error(`Unexpected extracted entry: ${path}`);
      const absolute = join(canonical, path);
      const info = await lstat(absolute);
      seen.add(path);
      if (entry.kind === "directory") {
        if (!info.isDirectory()) throw new Error(`Extracted directory mismatch: ${path}`);
        await visit(path);
      } else if (entry.kind === "symlink") {
        if (
          !info.isSymbolicLink() ||
          (await readlink(absolute)) !== entry.target ||
          !isWithin(canonical, await realpath(absolute))
        ) {
          throw new Error(`Extracted link mismatch: ${path}`);
        }
      } else if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== entry.size ||
        (await hashFile(absolute)) !== entry.sha256
      ) {
        throw new Error(`Extracted file mismatch: ${path}`);
      }
      if (entry.kind !== "symlink" && (info.mode & 0o777) !== entry.mode) {
        throw new Error(`Extracted mode mismatch: ${path}`);
      }
    }
  }
  await visit("");
  if (seen.size !== expected.size) throw new Error("Extracted closure is incomplete.");
}

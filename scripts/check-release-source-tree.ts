import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseSourceChanges } from "./lib/release-source-changes.ts";

/**
 * Prints every source tree change except the expected release version stamp for `<version>`,
 * one `git status --porcelain` entry per line. Empty output means provenance records a clean
 * source revision; callers decide whether remaining changes are an error or a warning.
 */
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const [version, ...rest] = process.argv.slice(2);
    if (!version || rest.length > 0)
      throw new Error("Usage: node scripts/check-release-source-tree.ts <version>");
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const entry of releaseSourceChanges(repo, version).unexpected) console.log(entry);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

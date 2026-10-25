import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const scriptsRoot = fileURLToPath(new URL("../", import.meta.url));
export const checkpointNodeTestFiles = [
  "checkpoint.extension.artifacts.test.mjs",
  "checkpoint.extension.codec.test.mjs",
  "checkpoint.extension.custody.test.mjs",
] as const;
export const checkpointNodeTestExcludes = checkpointNodeTestFiles.map(
  (name) => `terminal-reliability/${name}`,
);

/** Only filenames are inspected. Missing or additional harnesses require an explicit inventory update. */
export function discoverCheckpointNodeTests(
  directory = path.join(scriptsRoot, "terminal-reliability"),
): string[] {
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^checkpoint\.extension\..+\.test\.mjs$/.test(entry.name))
    .map((entry) => entry.name)
    .toSorted();
  if (
    names.length !== checkpointNodeTestFiles.length ||
    names.some((name, index) => name !== checkpointNodeTestFiles[index])
  ) {
    throw new Error(
      `Checkpoint Node test inventory mismatch: expected ${checkpointNodeTestFiles.join(", ")}; found ${names.slice(0, 4).join(", ") || "none"}`,
    );
  }
  return names.map((name) => path.resolve(directory, name));
}

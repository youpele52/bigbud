import { copyFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

function isWithin(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/** Preserve root-manifest patch inputs when staging an isolated Bun lockfile update. */
export function copyReleaseSmokePatches(repoRoot: string, targetRoot: string): void {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    patchedDependencies?: unknown;
  };
  const patches = manifest.patchedDependencies;
  if (patches === undefined) return;
  if (patches === null || typeof patches !== "object" || Array.isArray(patches)) {
    throw new Error("Release smoke patchedDependencies must be a package-to-path mapping.");
  }
  const root = realpathSync(repoRoot);
  for (const patch of new Set(Object.values(patches))) {
    if (
      typeof patch !== "string" ||
      !patch.trim() ||
      patch.includes("\0") ||
      patch.includes("\\") ||
      patch.includes(":") ||
      patch.split("/").includes("..") ||
      isAbsolute(patch) ||
      win32.isAbsolute(patch)
    ) {
      throw new Error("Release smoke patch paths must be portable repository-relative file paths.");
    }
    const source = realpathSync(resolve(root, patch));
    if (!isWithin(root, source)) {
      throw new Error(`Release smoke patch escapes the repository: ${patch}`);
    }
    const destination = resolve(targetRoot, patch);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

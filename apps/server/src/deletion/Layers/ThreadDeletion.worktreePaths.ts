import path from "node:path";

type PathOps = Pick<typeof path, "resolve" | "relative" | "isAbsolute" | "sep">;

export function recordedWorktreePathsOverlap(
  left: string,
  right: string,
  pathOps: PathOps = path,
): boolean {
  const normalize = (value: string) => {
    const resolved = pathOps.resolve(value);
    return pathOps.sep === "\\" ? resolved.toLowerCase() : resolved;
  };
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(`${b}${pathOps.sep}`) || b.startsWith(`${a}${pathOps.sep}`);
}

/** Classify a recorded path using the host platform's path rules before any file access. */
export function managedWorktreeRelativePath(
  root: string,
  recordedPath: string,
  pathOps: PathOps = path,
): string | null {
  const managedRoot = pathOps.resolve(root);
  const target = pathOps.resolve(recordedPath);
  const normalizedRoot = pathOps.sep === "\\" ? managedRoot.toLowerCase() : managedRoot;
  const normalizedRecorded = pathOps.sep === "\\" ? recordedPath.toLowerCase() : recordedPath;
  const normalizedTarget = pathOps.sep === "\\" ? target.toLowerCase() : target;
  const prefix = `${normalizedRoot}${pathOps.sep}`;
  const lexicalRelative = normalizedRecorded.startsWith(prefix)
    ? recordedPath.slice(prefix.length)
    : null;
  if (
    normalizedTarget === normalizedRoot ||
    lexicalRelative?.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("unsafe managed worktree path");
  }
  const relative = pathOps.relative(managedRoot, target);
  if (
    relative.length === 0 ||
    relative.includes("\0") ||
    pathOps.isAbsolute(relative) ||
    relative.split(/[\\/]/u).some((segment) => segment === ".." || segment === "")
  ) {
    return null;
  }
  return relative;
}

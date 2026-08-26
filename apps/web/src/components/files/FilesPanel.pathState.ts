import type { DirectoryState } from "./FilesPanel.shared";

export type DirectoryPathReachability = "reachable" | "unreachable" | "unknown";

function isPathWithin(path: string, parentPath: string): boolean {
  return path === parentPath || path.startsWith(`${parentPath}/`);
}

export function getDirectoryPathReachability(
  path: string,
  directoryStateByPath: Readonly<Record<string, DirectoryState>>,
): DirectoryPathReachability {
  if (path.length === 0) return "reachable";

  let parentPath = "";
  for (const segment of path.split("/")) {
    const state = directoryStateByPath[parentPath];
    if (!state) return "unknown";

    const currentPath = parentPath ? `${parentPath}/${segment}` : segment;
    const directoryExists = state.entries.some(
      (entry) => entry.path === currentPath && entry.kind === "directory",
    );
    if (!directoryExists) {
      return state.loading || state.error !== null ? "unknown" : "unreachable";
    }
    parentPath = currentPath;
  }

  return "reachable";
}

export function getReachableDirectoryPaths(
  directoryStateByPath: Readonly<Record<string, DirectoryState>>,
): ReadonlySet<string> {
  const reachablePaths = new Set<string>([""]);
  const pendingPaths = [""];

  for (let index = 0; index < pendingPaths.length; index += 1) {
    const parentPath = pendingPaths[index];
    if (parentPath === undefined) continue;
    const state = directoryStateByPath[parentPath];
    if (!state) continue;

    for (const entry of state.entries) {
      if (entry.kind !== "directory" || reachablePaths.has(entry.path)) continue;
      reachablePaths.add(entry.path);
      pendingPaths.push(entry.path);
    }
  }

  return reachablePaths;
}

export function getVisibleDirectoryPaths(
  expandedDirectories: Readonly<Record<string, boolean>>,
  directoryStateByPath: Readonly<Record<string, DirectoryState>>,
): string[] {
  const visiblePaths = new Set<string>([""]);
  const reachablePaths = getReachableDirectoryPaths(directoryStateByPath);

  for (const [path, expanded] of Object.entries(expandedDirectories)) {
    if (!expanded || directoryStateByPath[path] === undefined || !reachablePaths.has(path)) {
      continue;
    }
    visiblePaths.add(path);
  }

  return [...visiblePaths].toSorted((left, right) => left.localeCompare(right));
}

export function pruneRemovedPaths<T>(
  valuesByPath: Readonly<Record<string, T>>,
  removedPaths: ReadonlyArray<string>,
): Record<string, T> {
  if (removedPaths.length === 0) return valuesByPath;

  const retainedEntries = Object.entries(valuesByPath).filter(
    ([path]) => !removedPaths.some((removedPath) => isPathWithin(path, removedPath)),
  );
  if (retainedEntries.length === Object.keys(valuesByPath).length) return valuesByPath;
  return Object.fromEntries(retainedEntries);
}

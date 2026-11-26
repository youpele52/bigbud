interface FilesPanelWorkspaceKeyInput {
  readonly projectId?: string | undefined;
  readonly workspaceRoot: string | null;
  readonly executionTargetId?: string | undefined;
  readonly isolatedId?: string | undefined;
}

function normalizeWorkspaceRoot(path: string): string {
  if (path === "/" || /^[A-Za-z]:[\\/]?$/.test(path)) return path.replaceAll("\\", "/");
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

export function createFilesPanelWorkspaceKey({
  projectId,
  workspaceRoot,
  executionTargetId,
  isolatedId,
}: FilesPanelWorkspaceKeyInput): string {
  const target = executionTargetId ?? "local";
  // History entries are root-relative, so every key names its absolute root: (key, path) is one
  // absolute file on one target, and a project's worktrees never share (and prune) entries.
  const root = workspaceRoot ? normalizeWorkspaceRoot(workspaceRoot) : "";
  if (projectId) return `project:${projectId}:${root}::${target}`;
  if (root) return `chat:${root}::${target}`;
  return `isolated:${isolatedId ?? "unassigned"}::${target}`;
}

/**
 * Open requests always name their root. A root equal to the panel's own workspace (same folder,
 * and the same execution target when one is given) is that workspace, so it keeps the project's
 * name, thread and history; any other root is a separate workspace. Returns the override to use.
 */
export function resolveFilesPanelWorkspaceRootOverride(input: {
  readonly requestedRoot: string | null;
  readonly requestedExecutionTargetId: string | null;
  readonly workspaceRoot: string | null | undefined;
  readonly workspaceExecutionTargetId: string | null | undefined;
}): string | null {
  const { requestedRoot, workspaceRoot } = input;
  if (requestedRoot === null || !workspaceRoot) return requestedRoot;
  const sameTarget =
    input.requestedExecutionTargetId === null ||
    input.requestedExecutionTargetId === (input.workspaceExecutionTargetId ?? "local");
  return sameTarget &&
    normalizeWorkspaceRoot(requestedRoot) === normalizeWorkspaceRoot(workspaceRoot)
    ? null
    : requestedRoot;
}

/** The absolute root and target a history key names; `null` for isolated (folder-less) keys. */
export function parseFilesPanelWorkspaceKey(
  key: string,
): { readonly root: string; readonly executionTargetId: string } | null {
  const separator = key.lastIndexOf("::");
  if (separator < 0) return null;
  const head = key.slice(0, separator);
  const executionTargetId = key.slice(separator + 2);
  let root: string | null = null;
  if (head.startsWith("chat:")) root = head.slice("chat:".length);
  else if (head.startsWith("project:")) {
    const rootStart = head.indexOf(":", "project:".length);
    root = rootStart < 0 ? null : head.slice(rootStart + 1);
  }
  return root ? { root, executionTargetId } : null;
}

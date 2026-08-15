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
  if (projectId) return `project:${projectId}::${target}`;
  if (workspaceRoot) return `chat:${normalizeWorkspaceRoot(workspaceRoot)}::${target}`;
  return `isolated:${isolatedId ?? "unassigned"}::${target}`;
}

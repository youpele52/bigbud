export const BIGBUD_FILES_PANEL_DRAG_MIME = "application/x-bigbud-files-panel-entry";

export interface FilesPanelDragEntry {
  name: string;
  path: string;
  entryKind: "file" | "directory";
}

export function serializeFilesPanelDragEntry(entry: FilesPanelDragEntry): string {
  return JSON.stringify(entry);
}

export function parseFilesPanelDragEntry(value: string): FilesPanelDragEntry | null {
  try {
    const parsed = JSON.parse(value) as Partial<FilesPanelDragEntry>;
    if (
      typeof parsed.name !== "string" ||
      parsed.name.length === 0 ||
      typeof parsed.path !== "string" ||
      parsed.path.length === 0 ||
      (parsed.entryKind !== "file" && parsed.entryKind !== "directory")
    ) {
      return null;
    }
    return {
      name: parsed.name,
      path: parsed.path,
      entryKind: parsed.entryKind,
    };
  } catch {
    return null;
  }
}

/**
 * Joins a workspace root with a relative entry path and returns an absolute
 * POSIX path. Collapses duplicate slashes and tolerates either side having
 * stray leading/trailing slashes. Falls back to the relative path when the
 * workspace root is unknown (the agent can still resolve it from context).
 */
export function joinWorkspaceEntryPath(
  workspaceRoot: string | null | undefined,
  relativePath: string,
): string {
  if (!workspaceRoot || workspaceRoot.length === 0) {
    return relativePath;
  }
  const root = workspaceRoot.replace(/\/+$/, "");
  const rel = relativePath.replace(/^\/+/, "");
  if (rel.length === 0) return root;
  return `${root}/${rel}`;
}

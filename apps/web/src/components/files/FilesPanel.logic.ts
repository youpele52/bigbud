import type { ProjectEntry } from "@bigbud/contracts";
import type { Dispatch, SetStateAction } from "react";

import { isCodeRelatedFilePath, openPathInPreferredApp } from "../../models/editor";
import { readNativeApi } from "../../rpc/nativeApi";
import { joinWorkspaceEntryPath } from "./filesPanel.dnd";

interface ReconcilePreviewPathAfterDirectoryRefreshInput {
  readonly previewPath: string | null;
  readonly refreshedRelativePath: string;
  readonly previousEntries: ReadonlyArray<ProjectEntry>;
  readonly nextEntries: ReadonlyArray<ProjectEntry>;
}

export function reconcilePreviewPathAfterDirectoryRefresh({
  previewPath,
  refreshedRelativePath,
  previousEntries,
  nextEntries,
}: ReconcilePreviewPathAfterDirectoryRefreshInput): string | null {
  if (!previewPath) {
    return previewPath;
  }

  const previousPreviewEntry = previousEntries.find((entry) => entry.path === previewPath);
  if (!previousPreviewEntry || (previousPreviewEntry.parentPath ?? "") !== refreshedRelativePath) {
    return previewPath;
  }

  if (nextEntries.some((entry) => entry.path === previewPath)) {
    return previewPath;
  }

  const previousPaths = new Set(previousEntries.map((entry) => entry.path));
  const nextPaths = new Set(nextEntries.map((entry) => entry.path));
  const removedEntries = previousEntries.filter((entry) => !nextPaths.has(entry.path));
  const addedEntries = nextEntries.filter((entry) => !previousPaths.has(entry.path));

  if (removedEntries.length !== 1 || addedEntries.length !== 1) {
    return null;
  }

  const removedEntry = removedEntries[0];
  const addedEntry = addedEntries[0];
  if (!removedEntry || !addedEntry) {
    return null;
  }

  if (removedEntry.path !== previewPath || removedEntry.kind !== addedEntry.kind) {
    return null;
  }

  return addedEntry.path;
}

export function applyDirectoryNavigationRequest(
  requestPath: string,
  directoryStateByPath: Readonly<Record<string, unknown>>,
  loadDirectory: (relativePath: string) => void | Promise<void>,
  setExpandedDirectories: Dispatch<SetStateAction<Record<string, boolean>>>,
): void {
  const segments = requestPath.split("/").filter((segment) => segment.length > 0);
  let currentPath = "";
  const nextExpanded: Record<string, boolean> = {};

  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    nextExpanded[currentPath] = true;
    if (directoryStateByPath[currentPath] === undefined) {
      void loadDirectory(currentPath);
    }
  }

  setExpandedDirectories((current) => ({ ...current, ...nextExpanded }));
}

export function openFilesPanelEntry(
  entry: ProjectEntry,
  workspaceRoot: string,
  setPreviewPath: (previewPath: string | null) => void,
  setPreviewPosition: (previewPosition: { line: number; column: number | null } | null) => void,
): void {
  if (isCodeRelatedFilePath(entry.path)) {
    setPreviewPath(entry.path);
    setPreviewPosition(null);
    return;
  }

  const absolutePath = joinWorkspaceEntryPath(workspaceRoot, entry.path);
  const api = readNativeApi();
  if (!api) return;

  void openPathInPreferredApp(api, absolutePath).catch((error) => {
    console.error("Failed to open file:", error);
  });
}

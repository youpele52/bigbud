import type { ProjectEntry } from "@bigbud/contracts";
import type { Dispatch, SetStateAction } from "react";

import {
  buildWorkspaceFilePreviewUrl,
  isHtmlFilePath,
  isImageFilePath,
  isPdfFilePath,
} from "../../lib/workspaceFilePreview";
import { openNewBrowserTab } from "../../stores/browser/browserPanel.actions";

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

  return null;
}

export function getRemovedEntryPaths(
  previousEntries: ReadonlyArray<ProjectEntry>,
  nextEntries: ReadonlyArray<ProjectEntry>,
): string[] {
  const nextPaths = new Set(nextEntries.map((entry) => entry.path));
  return previousEntries.filter((entry) => !nextPaths.has(entry.path)).map((entry) => entry.path);
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
  openPreview?: (path: string) => void,
  executionTargetId?: string | undefined,
): void {
  if (isPdfFilePath(entry.path) || isImageFilePath(entry.path) || isHtmlFilePath(entry.path)) {
    openNewBrowserTab({
      url: buildWorkspaceFilePreviewUrl({
        cwd: workspaceRoot,
        relativePath: entry.path,
        executionTargetId,
      }),
    });
    return;
  }

  if (openPreview) {
    openPreview(entry.path);
  } else {
    setPreviewPath(entry.path);
    setPreviewPosition(null);
  }
}

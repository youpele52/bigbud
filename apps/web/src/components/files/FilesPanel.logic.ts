import type { ProjectEntry } from "@bigbud/contracts";
import type { Dispatch, SetStateAction } from "react";

import {
  buildWorkspaceFilePreviewUrl,
  isHtmlFilePath,
  isImageFilePath,
  isPdfFilePath,
} from "../../lib/workspaceFilePreview";
import { openNewBrowserTab } from "../../stores/browser/browserPanel.actions";
import type { FileHistoryEntry } from "../../stores/files/filesPanel.history";

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

export function getParentDirectoryPath(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex < 0 ? "" : path.slice(0, separatorIndex);
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

  setExpandedDirectories((current) => {
    const requiresUpdate = Object.keys(nextExpanded).some((path) => current[path] !== true);
    return requiresUpdate ? { ...current, ...nextExpanded } : current;
  });
}

export function applyPreviewDirectoryNavigation(
  previewPath: string,
  directoryStateByPath: Readonly<Record<string, unknown>>,
  loadDirectory: (relativePath: string) => void | Promise<void>,
  setExpandedDirectories: Dispatch<SetStateAction<Record<string, boolean>>>,
): void {
  const parentDirectoryPath = getParentDirectoryPath(previewPath);
  if (!parentDirectoryPath) return;

  applyDirectoryNavigationRequest(
    parentDirectoryPath,
    directoryStateByPath,
    loadDirectory,
    setExpandedDirectories,
  );
}

interface ApplyFileOpenRequestInput {
  readonly request: Pick<FileHistoryEntry, "path" | "position"> & { readonly requestId: number };
  readonly directoryStateByPath: Readonly<Record<string, unknown>>;
  readonly loadDirectory: (relativePath: string) => void | Promise<void>;
  readonly setExpandedDirectories: Dispatch<SetStateAction<Record<string, boolean>>>;
  readonly openPreview: (entry: FileHistoryEntry) => void;
  readonly consumeRequest: (requestId: number) => void;
}

export function applyFileOpenRequest({
  request,
  directoryStateByPath,
  loadDirectory,
  setExpandedDirectories,
  openPreview,
  consumeRequest,
}: ApplyFileOpenRequestInput): void {
  applyPreviewDirectoryNavigation(
    request.path,
    directoryStateByPath,
    loadDirectory,
    setExpandedDirectories,
  );
  openPreview({ path: request.path, position: request.position, scrollTop: null });
  consumeRequest(request.requestId);
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

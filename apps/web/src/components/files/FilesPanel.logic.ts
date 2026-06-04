import type { ProjectEntry } from "@bigbud/contracts";
import type { Dispatch, SetStateAction } from "react";

import { isCodeRelatedFilePath, openPathInPreferredApp } from "../../models/editor";
import { readNativeApi } from "../../rpc/nativeApi";
import { joinWorkspaceEntryPath } from "./filesPanel.dnd";

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

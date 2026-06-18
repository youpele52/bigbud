import {
  isCodeRelatedFilePath,
  parsePathPositionSuffix,
  openPathInPreferredApp,
  stripPathPositionSuffix,
} from "../../models/editor";
import { openNewBrowserTab } from "../browser/browserPanel.actions";
import { buildWorkspaceFilePreviewUrl, isPdfFilePath } from "../../lib/workspaceFilePreview";
import { readNativeApi } from "../../rpc/nativeApi";
import { openDirectoryInFilesPanel, openFileInFilesPanel } from "./filesPanel.coordinator";

function normalizePathForCompare(pathValue: string): string {
  return pathValue.replaceAll("\\", "/").replace(/\/+$/, "");
}

function isWindowsStylePath(pathValue: string): boolean {
  return /^[A-Za-z]:\//.test(pathValue);
}

export function resolveWorkspaceRelativeEntryPath(
  targetPath: string,
  workspaceRoot: string | undefined,
): string | null {
  if (!workspaceRoot) return null;

  const strippedTargetPath = stripPathPositionSuffix(targetPath);
  const normalizedTarget = normalizePathForCompare(strippedTargetPath);
  const normalizedRoot = normalizePathForCompare(workspaceRoot);

  if (normalizedTarget.length === 0 || normalizedRoot.length === 0) {
    return null;
  }

  const comparableTarget = isWindowsStylePath(normalizedTarget)
    ? normalizedTarget.toLowerCase()
    : normalizedTarget;
  const comparableRoot = isWindowsStylePath(normalizedRoot)
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;

  if (comparableTarget === comparableRoot || !comparableTarget.startsWith(`${comparableRoot}/`)) {
    return null;
  }

  return normalizedTarget.slice(normalizedRoot.length + 1);
}

export function canOpenPathInFilesPanel(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  return (
    isCodeRelatedFilePath(targetPath) &&
    resolveWorkspaceRelativeEntryPath(targetPath, workspaceRoot) !== null
  );
}

export function canOpenPathInBrowserPanel(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  const relativePath = resolveWorkspaceRelativeEntryPath(targetPath, workspaceRoot);
  return relativePath !== null && isPdfFilePath(relativePath);
}

export function canOpenPathInternally(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  return (
    canOpenPathInBrowserPanel(targetPath, workspaceRoot) ||
    canOpenPathInFilesPanel(targetPath, workspaceRoot)
  );
}

export function canOpenDirectoryInFilesPanel(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  return resolveWorkspaceRelativeEntryPath(targetPath, workspaceRoot) !== null;
}

export function openPathInBrowserPanelIfSupported(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  const relativePath = resolveWorkspaceRelativeEntryPath(targetPath, workspaceRoot);
  if (!relativePath || !workspaceRoot || !isPdfFilePath(relativePath)) {
    return false;
  }

  openNewBrowserTab({
    url: buildWorkspaceFilePreviewUrl({
      cwd: workspaceRoot,
      relativePath,
    }),
  });
  return true;
}

export function openPathInFilesPanelIfSupported(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  const relativePath = resolveWorkspaceRelativeEntryPath(targetPath, workspaceRoot);
  if (!relativePath || !isCodeRelatedFilePath(targetPath)) {
    return false;
  }

  openFileInFilesPanel(relativePath, parsePathPositionSuffix(targetPath));
  return true;
}

export function openDirectoryInFilesPanelIfSupported(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  const relativePath = resolveWorkspaceRelativeEntryPath(targetPath, workspaceRoot);
  if (!relativePath) {
    return false;
  }

  openDirectoryInFilesPanel(relativePath);
  return true;
}

export async function openPathFromChat(
  targetPath: string,
  workspaceRoot: string | undefined,
): Promise<void> {
  if (openPathInBrowserPanelIfSupported(targetPath, workspaceRoot)) {
    return;
  }

  if (openPathInFilesPanelIfSupported(targetPath, workspaceRoot)) {
    return;
  }

  const api = readNativeApi();
  if (!api) {
    console.warn("Native API not found. Unable to open file.");
    return;
  }

  await openPathInPreferredApp(api, targetPath);
}

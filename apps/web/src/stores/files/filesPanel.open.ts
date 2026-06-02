import {
  isCodeRelatedFilePath,
  parsePathPositionSuffix,
  openPathInPreferredApp,
  stripPathPositionSuffix,
} from "../../models/editor";
import { readNativeApi } from "../../rpc/nativeApi";
import { openFileInFilesPanel } from "./filesPanel.coordinator";

function normalizePathForCompare(pathValue: string): string {
  return pathValue.replaceAll("\\", "/").replace(/\/+$/, "");
}

function isWindowsStylePath(pathValue: string): boolean {
  return /^[A-Za-z]:\//.test(pathValue);
}

export function resolveWorkspaceRelativePreviewPath(
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
    resolveWorkspaceRelativePreviewPath(targetPath, workspaceRoot) !== null
  );
}

export function openPathInFilesPanelIfSupported(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  const relativePath = resolveWorkspaceRelativePreviewPath(targetPath, workspaceRoot);
  if (!relativePath || !isCodeRelatedFilePath(targetPath)) {
    return false;
  }

  openFileInFilesPanel(relativePath, parsePathPositionSuffix(targetPath));
  return true;
}

export async function openPathFromChat(
  targetPath: string,
  workspaceRoot: string | undefined,
): Promise<void> {
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

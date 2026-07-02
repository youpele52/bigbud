import {
  isCodeRelatedFilePath,
  parsePathPositionSuffix,
  openPathInPreferredApp,
  stripPathPositionSuffix,
} from "../../models/editor";
import { openNewBrowserTab } from "../browser/browserPanel.actions";
import {
  buildWorkspaceFilePreviewUrl,
  isHtmlFilePath,
  isImageFilePath,
  isPdfFilePath,
  isVideoFilePath,
} from "../../lib/workspaceFilePreview";
import { readNativeApi } from "../../rpc/nativeApi";
import { openDirectoryInFilesPanel, openFileInFilesPanel } from "./filesPanel.coordinator";

interface InternalOpenTarget {
  cwd: string;
  relativePath: string;
  workspaceRootOverride: string | null;
}

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

function isAbsolutePath(pathValue: string): boolean {
  return pathValue.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pathValue);
}

function trimTrailingSeparators(pathValue: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(pathValue) || pathValue === "/") {
    return pathValue.replaceAll("\\", "/");
  }

  return pathValue.replaceAll("\\", "/").replace(/\/+$/, "");
}

function splitAbsolutePath(pathValue: string): { cwd: string; name: string } | null {
  const normalizedPath = trimTrailingSeparators(stripPathPositionSuffix(pathValue));
  const slashIndex = normalizedPath.lastIndexOf("/");
  if (slashIndex < 0 || slashIndex === normalizedPath.length - 1) {
    return null;
  }

  const cwd =
    slashIndex === 0
      ? "/"
      : /^[A-Za-z]:$/.test(normalizedPath.slice(0, slashIndex))
        ? `${normalizedPath.slice(0, slashIndex)}/`
        : normalizedPath.slice(0, slashIndex);
  const name = normalizedPath.slice(slashIndex + 1);
  if (name.length === 0) {
    return null;
  }

  return { cwd, name };
}

function resolveInternalOpenTarget(
  targetPath: string,
  workspaceRoot: string | undefined,
): InternalOpenTarget | null {
  const relativePath = resolveWorkspaceRelativeEntryPath(targetPath, workspaceRoot);
  if (relativePath !== null && workspaceRoot) {
    return {
      cwd: trimTrailingSeparators(workspaceRoot),
      relativePath,
      workspaceRootOverride: null,
    };
  }

  const strippedTargetPath = stripPathPositionSuffix(targetPath);
  if (!isAbsolutePath(strippedTargetPath)) {
    if (!workspaceRoot) {
      return null;
    }

    return {
      cwd: trimTrailingSeparators(workspaceRoot),
      relativePath: normalizePathForCompare(strippedTargetPath),
      workspaceRootOverride: null,
    };
  }

  const splitPath = splitAbsolutePath(strippedTargetPath);
  if (!splitPath) {
    return null;
  }

  return {
    cwd: splitPath.cwd,
    relativePath: splitPath.name,
    workspaceRootOverride: splitPath.cwd,
  };
}

function resolveDirectoryOpenTarget(
  targetPath: string,
  workspaceRoot: string | undefined,
): { path: string; workspaceRootOverride: string | null } | null {
  const relativePath = resolveWorkspaceRelativeEntryPath(targetPath, workspaceRoot);
  if (relativePath !== null) {
    return { path: relativePath, workspaceRootOverride: null };
  }

  const strippedTargetPath = stripPathPositionSuffix(targetPath);
  if (!isAbsolutePath(strippedTargetPath)) {
    return null;
  }

  return {
    path: "",
    workspaceRootOverride: trimTrailingSeparators(strippedTargetPath),
  };
}

export function canOpenPathInFilesPanel(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  const openTarget = resolveInternalOpenTarget(targetPath, workspaceRoot);
  if (openTarget === null) {
    return false;
  }
  return (
    isCodeRelatedFilePath(targetPath) || isImageFilePath(targetPath) || isVideoFilePath(targetPath)
  );
}

export function canOpenPathInBrowserPanel(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  const relativePath = resolveInternalOpenTarget(targetPath, workspaceRoot)?.relativePath;
  return (
    relativePath !== null &&
    relativePath !== undefined &&
    (isPdfFilePath(relativePath) || isImageFilePath(relativePath) || isHtmlFilePath(relativePath))
  );
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
  return resolveDirectoryOpenTarget(targetPath, workspaceRoot) !== null;
}

export function openPathInBrowserPanelIfSupported(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  const openTarget = resolveInternalOpenTarget(targetPath, workspaceRoot);
  if (!openTarget) {
    return false;
  }
  const { cwd, relativePath } = openTarget;
  if (
    !isPdfFilePath(relativePath) &&
    !isImageFilePath(relativePath) &&
    !isHtmlFilePath(relativePath)
  ) {
    return false;
  }

  openNewBrowserTab({
    url: buildWorkspaceFilePreviewUrl({
      cwd,
      relativePath,
    }),
  });
  return true;
}

export function openPathInFilesPanelIfSupported(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  const openTarget = resolveInternalOpenTarget(targetPath, workspaceRoot);
  if (!openTarget) {
    return false;
  }
  const { relativePath, workspaceRootOverride } = openTarget;
  if (
    !isCodeRelatedFilePath(targetPath) &&
    !isImageFilePath(targetPath) &&
    !isVideoFilePath(targetPath)
  ) {
    return false;
  }

  openFileInFilesPanel(relativePath, parsePathPositionSuffix(targetPath), workspaceRootOverride);
  return true;
}

export function openDirectoryInFilesPanelIfSupported(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  const openTarget = resolveDirectoryOpenTarget(targetPath, workspaceRoot);
  if (!openTarget) {
    return false;
  }

  openDirectoryInFilesPanel(openTarget.path, openTarget.workspaceRootOverride);
  return true;
}

export async function openPathFromChat(
  targetPath: string,
  workspaceRoot: string | undefined,
  kind: "file" | "directory" = "file",
): Promise<void> {
  if (kind === "directory" && openDirectoryInFilesPanelIfSupported(targetPath, workspaceRoot)) {
    return;
  }

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

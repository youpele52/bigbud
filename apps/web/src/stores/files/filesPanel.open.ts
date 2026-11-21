import {
  isRemoteExecutionTargetId,
  type ExecutionTargetId,
} from "@bigbud/contracts/core/baseSchemas";
import {
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
} from "../../lib/workspaceFilePreview";
import { joinWorkspaceEntryPath } from "../../components/files/filesPanel.dnd";
import {
  describeSystemOpenResult,
  REMOTE_UNSUPPORTED_NOTICE,
} from "../../components/layout/SearchPalette.open.logic";
import { toastManager } from "../../components/ui/toast";
import { inAppViewerFor, openWithSystemDefault } from "../../lib/openSystemPath";
import { readNativeApi } from "../../rpc/nativeApi";
import { openDirectoryInFilesPanel, openFileInFilesPanel } from "./filesPanel.coordinator";

/**
 * Every open names its Files panel root explicitly (`workspaceRoot`): a path is never resolved
 * against whichever project happens to be active. The Files panel treats a root equal to its own
 * workspace as that workspace (`resolveFilesPanelWorkspaceRoot`).
 */
interface InternalOpenTarget {
  cwd: string;
  relativePath: string;
  workspaceRoot: string;
}

function normalizePathForCompare(pathValue: string): string {
  return pathValue.replaceAll("\\", "/").replace(/\/+$/, "");
}

function isWindowsStylePath(pathValue: string): boolean {
  return /^[A-Za-z]:\//.test(pathValue) || pathValue.startsWith("//");
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
    const cwd = trimTrailingSeparators(workspaceRoot);
    return { cwd, relativePath, workspaceRoot: cwd };
  }

  const strippedTargetPath = stripPathPositionSuffix(targetPath);
  if (!isAbsolutePath(strippedTargetPath)) {
    if (!workspaceRoot) {
      return null;
    }

    // A relative link becomes absolute here, once, against the root it was written for.
    const cwd = trimTrailingSeparators(workspaceRoot);
    return { cwd, relativePath: normalizePathForCompare(strippedTargetPath), workspaceRoot: cwd };
  }

  const splitPath = splitAbsolutePath(strippedTargetPath);
  if (!splitPath) {
    return null;
  }

  return { cwd: splitPath.cwd, relativePath: splitPath.name, workspaceRoot: splitPath.cwd };
}

function resolveDirectoryOpenTarget(
  targetPath: string,
  workspaceRoot: string | undefined,
): { path: string; workspaceRoot: string } | null {
  const relativePath = resolveWorkspaceRelativeEntryPath(targetPath, workspaceRoot);
  if (relativePath !== null && workspaceRoot) {
    return { path: relativePath, workspaceRoot: trimTrailingSeparators(workspaceRoot) };
  }

  const strippedTargetPath = stripPathPositionSuffix(targetPath);
  if (!isAbsolutePath(strippedTargetPath)) {
    return null;
  }

  return { path: "", workspaceRoot: trimTrailingSeparators(strippedTargetPath) };
}

export function canOpenPathInFilesPanel(
  targetPath: string,
  workspaceRoot: string | undefined,
): boolean {
  const openTarget = resolveInternalOpenTarget(targetPath, workspaceRoot);
  if (openTarget === null) {
    return false;
  }
  return true;
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
  executionTargetId?: ExecutionTargetId | undefined,
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
      executionTargetId,
    }),
  });
  return true;
}

export function openPathInFilesPanelIfSupported(
  targetPath: string,
  workspaceRoot: string | undefined,
  executionTargetId?: ExecutionTargetId | undefined,
): boolean {
  const openTarget = resolveInternalOpenTarget(targetPath, workspaceRoot);
  if (!openTarget) {
    return false;
  }
  openFileInFilesPanel(
    openTarget.relativePath,
    parsePathPositionSuffix(targetPath),
    openTarget.workspaceRoot,
    executionTargetId,
  );
  return true;
}

export function openDirectoryInFilesPanelIfSupported(
  targetPath: string,
  workspaceRoot: string | undefined,
  executionTargetId?: ExecutionTargetId | undefined,
): boolean {
  const openTarget = resolveDirectoryOpenTarget(targetPath, workspaceRoot);
  if (!openTarget) {
    return false;
  }

  openDirectoryInFilesPanel(openTarget.path, openTarget.workspaceRoot, executionTargetId);
  return true;
}

export async function openPathFromChat(
  targetPath: string,
  workspaceRoot: string | undefined,
  kind: "file" | "directory" = "file",
  executionTargetId?: ExecutionTargetId | undefined,
): Promise<void> {
  if (
    kind === "directory" &&
    openDirectoryInFilesPanelIfSupported(targetPath, workspaceRoot, executionTargetId)
  ) {
    return;
  }

  if (openPathInBrowserPanelIfSupported(targetPath, workspaceRoot, executionTargetId)) {
    return;
  }

  // Types bigbud cannot show: the system app for local files, a notice for remote ones (their
  // path only exists on the remote host). Never the current project's app or folder.
  const strippedPath = stripPathPositionSuffix(targetPath);
  if (kind === "file" && inAppViewerFor(strippedPath) === null) {
    if (isRemoteExecutionTargetId(executionTargetId)) {
      toastManager.add(REMOTE_UNSUPPORTED_NOTICE);
      return;
    }
    const absolutePath = isAbsolutePath(strippedPath)
      ? strippedPath
      : joinWorkspaceEntryPath(workspaceRoot, strippedPath);
    const notice = describeSystemOpenResult(await openWithSystemDefault(absolutePath));
    if (notice) toastManager.add(notice);
    return;
  }

  if (openPathInFilesPanelIfSupported(targetPath, workspaceRoot, executionTargetId)) {
    return;
  }

  const api = readNativeApi();
  if (!api) {
    console.warn("Native API not found. Unable to open file.");
    return;
  }

  await openPathInPreferredApp(api, targetPath);
}

/**
 * Opens `path` (absolute, or relative to `root`) in the Files panel rooted at `root`. For callers
 * that hold a root-relative path (diffs, Git changes): the path becomes absolute here, against
 * the root it came from.
 */
export function openRootFileInFilesPanel(
  root: string,
  path: string,
  executionTargetId?: ExecutionTargetId | undefined,
): boolean {
  const absolutePath = isAbsolutePath(path) ? path : joinWorkspaceEntryPath(root, path);
  return openPathInFilesPanelIfSupported(absolutePath, root, executionTargetId);
}

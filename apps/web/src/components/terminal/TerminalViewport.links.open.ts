import {
  isRemoteExecutionTargetId,
  type ExecutionTargetId,
  type NativeApi,
  type ProjectEntry,
} from "@bigbud/contracts";

import {
  buildWorkspaceFilePreviewUrl,
  isHtmlFilePath,
  isImageFilePath,
  isPdfFilePath,
} from "../../lib/workspaceFilePreview";
import {
  parsePathPositionSuffix,
  stripPathPositionSuffix,
  type PathPosition,
} from "../../models/editor";
import { openNewBrowserTab } from "../../stores/browser/browserPanel.actions";
import {
  openDirectoryInFilesPanel,
  openFileInFilesPanel,
} from "../../stores/files/filesPanel.coordinator";
import {
  openDirectoryInFilesPanelIfSupported,
  openPathInBrowserPanelIfSupported,
  openPathInFilesPanelIfSupported,
} from "../../stores/files/filesPanel.open";
import { resolvePathLinkTarget } from "../../utils/terminal/links.utils";

interface NormalizedPath {
  readonly absolutePath: string;
  readonly root: string;
  readonly segments: ReadonlyArray<string>;
  readonly windowsStyle: boolean;
}

interface ResolvedTerminalPath {
  readonly path: NormalizedPath;
  readonly position: PathPosition | null;
}

interface ClassifiedTerminalPath extends ResolvedTerminalPath {
  readonly kind: ProjectEntry["kind"];
  readonly workspaceRelativePath: string | null;
}

export interface OpenTerminalPathInput {
  readonly api: NativeApi;
  readonly rawPath: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly executionTargetId?: ExecutionTargetId | undefined;
}

function normalizeSegments(rawSegments: ReadonlyArray<string>): string[] {
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

function parseAbsolutePath(pathValue: string): NormalizedPath | null {
  const slashPath = pathValue.replaceAll("\\", "/");
  const drive = slashPath.match(/^([A-Za-z]):(?:\/|$)/);
  if (drive) {
    const root = `${drive[1]}:/`;
    const segments = normalizeSegments(slashPath.slice(drive[0].length).split("/"));
    return {
      absolutePath: formatPath(root, segments),
      root,
      segments,
      windowsStyle: true,
    };
  }

  if (slashPath.startsWith("//")) {
    const unc = slashPath.match(/^\/\/([^/]+)\/([^/]+)(?:\/|$)/);
    if (!unc) return null;
    const root = `//${unc[1]}/${unc[2]}`;
    const segments = normalizeSegments(slashPath.slice(unc[0].length).split("/"));
    return {
      absolutePath: formatPath(root, segments),
      root,
      segments,
      windowsStyle: true,
    };
  }

  if (!slashPath.startsWith("/")) return null;
  const root = "/";
  const segments = normalizeSegments(slashPath.slice(1).split("/"));
  return {
    absolutePath: formatPath(root, segments),
    root,
    segments,
    windowsStyle: false,
  };
}

function formatPath(root: string, segments: ReadonlyArray<string>): string {
  if (segments.length === 0) return root;
  return root === "/" || root.endsWith("/")
    ? `${root}${segments.join("/")}`
    : `${root}/${segments.join("/")}`;
}

function normalizeRelativeEntryPath(pathValue: string): string | null {
  const segments: string[] = [];
  for (const segment of pathValue.replaceAll("\\", "/").split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function pathsUseSameRoot(left: NormalizedPath, right: NormalizedPath): boolean {
  const compare =
    left.windowsStyle || right.windowsStyle
      ? (value: string) => value.toLowerCase()
      : (value: string) => value;
  return compare(left.root) === compare(right.root);
}

function relativePathWithinRoot(target: NormalizedPath, root: NormalizedPath): string | null {
  if (!pathsUseSameRoot(target, root)) return null;
  const compare =
    target.windowsStyle || root.windowsStyle
      ? (value: string) => value.toLowerCase()
      : (value: string) => value;
  if (target.segments.length < root.segments.length) return null;
  for (let index = 0; index < root.segments.length; index += 1) {
    if (compare(target.segments[index] ?? "") !== compare(root.segments[index] ?? "")) {
      return null;
    }
  }
  return target.segments.slice(root.segments.length).join("/");
}

function resolveTerminalPath(rawPath: string, cwd: string): ResolvedTerminalPath {
  const resolvedPath = resolvePathLinkTarget(rawPath, cwd);
  const path = parseAbsolutePath(stripPathPositionSuffix(resolvedPath));
  if (!path) {
    throw new Error("Terminal path is missing or inaccessible.");
  }
  return { path, position: parsePathPositionSuffix(resolvedPath) };
}

function pathWithPosition(path: string, position: PathPosition | null): string {
  if (!position) return path;
  return `${path}:${position.line}${position.column === null ? "" : `:${position.column}`}`;
}

function entryMatchesPath(entry: ProjectEntry, expectedPath: string, windowsStyle: boolean) {
  const normalizedEntryPath = normalizeRelativeEntryPath(entry.path);
  if (normalizedEntryPath === null) return false;
  return windowsStyle
    ? normalizedEntryPath.toLowerCase() === expectedPath.toLowerCase()
    : normalizedEntryPath === expectedPath;
}

async function listDirectory(
  api: NativeApi,
  cwd: string,
  executionTargetId: ExecutionTargetId | undefined,
  relativePath?: string,
) {
  return api.projects.listDirectory({
    cwd,
    ...(executionTargetId ? { executionTargetId } : {}),
    ...(relativePath ? { relativePath } : {}),
  });
}

async function classifyTerminalPath(
  input: OpenTerminalPathInput,
  resolved: ResolvedTerminalPath,
): Promise<ClassifiedTerminalPath> {
  const workspaceRoot = parseAbsolutePath(input.workspaceRoot);
  if (!workspaceRoot) {
    throw new Error("Terminal workspace is unavailable.");
  }

  const workspaceRelativePath = relativePathWithinRoot(resolved.path, workspaceRoot);
  if (isRemoteExecutionTargetId(input.executionTargetId) && workspaceRelativePath === null) {
    throw new Error("Terminal path is outside the active remote workspace.");
  }

  if (workspaceRelativePath !== null) {
    if (workspaceRelativePath.length === 0) {
      await listDirectory(input.api, workspaceRoot.absolutePath, input.executionTargetId);
      return { ...resolved, kind: "directory", workspaceRelativePath };
    }

    const pathSegments = workspaceRelativePath.split("/");
    const entryName = pathSegments.at(-1);
    if (!entryName) throw new Error("Terminal path is missing or inaccessible.");
    const parentPath = pathSegments.slice(0, -1).join("/");
    const directory = await listDirectory(
      input.api,
      workspaceRoot.absolutePath,
      input.executionTargetId,
      parentPath || undefined,
    );
    const entry = directory.entries.find((candidate) =>
      entryMatchesPath(candidate, workspaceRelativePath, workspaceRoot.windowsStyle),
    );
    if (!entry) throw new Error("Terminal path is missing or inaccessible.");
    return { ...resolved, kind: entry.kind, workspaceRelativePath };
  }

  const parentSegments = resolved.path.segments.slice(0, -1);
  const entryName = resolved.path.segments.at(-1);
  if (!entryName) throw new Error("Terminal path is missing or inaccessible.");
  const parent = {
    ...resolved.path,
    absolutePath: formatPath(resolved.path.root, parentSegments),
    segments: parentSegments,
  };
  const directory = await listDirectory(input.api, parent.absolutePath, input.executionTargetId);
  const entry = directory.entries.find((candidate) =>
    entryMatchesPath(candidate, entryName, parent.windowsStyle),
  );
  if (!entry) throw new Error("Terminal path is missing or inaccessible.");
  return { ...resolved, kind: entry.kind, workspaceRelativePath: null };
}

function isBrowserPreviewPath(path: string): boolean {
  return isPdfFilePath(path) || isImageFilePath(path) || isHtmlFilePath(path);
}

/** Resolve, classify, and open a terminal path without falling back to shell editors. */
export async function openTerminalPath(input: OpenTerminalPathInput): Promise<void> {
  const resolved = resolveTerminalPath(input.rawPath, input.cwd);
  const classified = await classifyTerminalPath(input, resolved);
  const targetPath = pathWithPosition(classified.path.absolutePath, classified.position);
  const workspaceRoot = parseAbsolutePath(input.workspaceRoot)?.absolutePath ?? input.workspaceRoot;

  if (classified.kind === "directory") {
    if (classified.workspaceRelativePath !== null) {
      openDirectoryInFilesPanel(classified.workspaceRelativePath, null, input.executionTargetId);
      return;
    }
    if (!openDirectoryInFilesPanelIfSupported(targetPath, workspaceRoot, input.executionTargetId)) {
      throw new Error("Unable to open terminal directory.");
    }
    return;
  }

  if (classified.workspaceRelativePath !== null) {
    if (isBrowserPreviewPath(classified.workspaceRelativePath)) {
      openNewBrowserTab({
        url: buildWorkspaceFilePreviewUrl({
          cwd: workspaceRoot,
          relativePath: classified.workspaceRelativePath,
          executionTargetId: input.executionTargetId,
        }),
      });
      return;
    }
    openFileInFilesPanel(
      classified.workspaceRelativePath,
      classified.position,
      null,
      input.executionTargetId,
    );
    return;
  }

  if (openPathInBrowserPanelIfSupported(targetPath, workspaceRoot, input.executionTargetId)) {
    return;
  }
  if (openPathInFilesPanelIfSupported(targetPath, workspaceRoot, input.executionTargetId)) {
    return;
  }
  throw new Error("Unable to open terminal path.");
}

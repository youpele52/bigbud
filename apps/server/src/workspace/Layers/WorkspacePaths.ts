import { posix } from "node:path";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { hasWindowsPathAlias } from "./WorkspacePaths.windows.ts";
import * as OS from "node:os";
import { Effect, FileSystem, Layer, Path } from "effect";

import {
  WorkspacePaths,
  WorkspacePathOutsideRootError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootInvalidError,
  WorkspaceRootNotExistsError,
  type WorkspacePathsShape,
} from "../Services/WorkspacePaths.ts";

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(OS.homedir(), input.slice(2));
  }
  return input;
}

export const makeWorkspacePaths = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const normalizeWorkspaceRoot: WorkspacePathsShape["normalizeWorkspaceRoot"] = Effect.fn(
    "WorkspacePaths.normalizeWorkspaceRoot",
  )(function* (workspaceRoot) {
    const expandedRoot = expandHomePath(workspaceRoot, path);
    if (
      path.sep === "\\" &&
      (hasWindowsPathAlias(workspaceRoot) || hasWindowsPathAlias(expandedRoot))
    ) {
      return yield* new WorkspaceRootInvalidError({
        workspaceRoot,
        detail: "Windows workspace path segments cannot end in spaces or dots.",
      });
    }
    const normalizedWorkspaceRoot = path.resolve(expandedRoot);
    const workspaceStat = yield* fileSystem
      .stat(normalizedWorkspaceRoot)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!workspaceStat) {
      return yield* new WorkspaceRootNotExistsError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    if (workspaceStat.type !== "Directory") {
      return yield* new WorkspaceRootNotDirectoryError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    return normalizedWorkspaceRoot;
  });

  const resolveRelativePathWithinRoot: WorkspacePathsShape["resolveRelativePathWithinRoot"] =
    Effect.fn("WorkspacePaths.resolveRelativePathWithinRoot")(function* (input) {
      const local = isLocalExecutionTarget(input.executionTargetId);
      const targetPath = local ? path : posix;
      const normalizedInputPath = input.relativePath;
      if (
        normalizedInputPath.includes("\u0000") ||
        targetPath.isAbsolute(normalizedInputPath) ||
        (local &&
          path.sep === "\\" &&
          (hasWindowsPathAlias(input.workspaceRoot) || hasWindowsPathAlias(normalizedInputPath)))
      ) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      const absolutePath = targetPath.resolve(input.workspaceRoot, normalizedInputPath);
      const relativeToRoot = toPosixRelativePath(
        targetPath.relative(input.workspaceRoot, absolutePath),
      );
      if (
        relativeToRoot.length === 0 ||
        relativeToRoot === "." ||
        relativeToRoot.startsWith("../") ||
        relativeToRoot === ".." ||
        targetPath.isAbsolute(relativeToRoot)
      ) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      return {
        absolutePath,
        relativePath: relativeToRoot,
      };
    });

  return {
    normalizeWorkspaceRoot,
    resolveRelativePathWithinRoot,
  } satisfies WorkspacePathsShape;
});

export const WorkspacePathsLive = Layer.effect(WorkspacePaths, makeWorkspacePaths);

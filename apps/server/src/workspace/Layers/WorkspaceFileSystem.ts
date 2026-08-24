import { Cause, Effect, Exit, FileSystem, Layer, Path } from "effect";
import { resolveExecutionTargetId } from "@bigbud/contracts";
import { open, stat } from "node:fs/promises";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { runToolCommand, resolveToolTransportTarget } from "../../tool-transport/toolTransport.ts";
import { resolveWorkspaceTarget } from "../../workspace-target/workspaceTarget.ts";
import {
  isRipgrepCommandNotFound,
  normalizeSearchCommandError,
  parseRipgrepJsonMatches,
  searchFileContentsWithoutRipgrep,
  WORKSPACE_FILE_CONTENT_SEARCH_IGNORED_GLOBS,
  WORKSPACE_FILE_CONTENT_SEARCH_MAX_BUFFER_BYTES,
  WORKSPACE_FILE_CONTENT_SEARCH_TIMEOUT_MS,
} from "./WorkspaceFileSystem.search.ts";
import { makeWorkspaceFileRange } from "./WorkspaceFileSystem.range.ts";
import { watchRemoteDirectoryViaSsh } from "./WorkspaceFileSystem.remoteWatch.ts";
import { makeWorkspaceWriteFile } from "./WorkspaceFileSystem.write.ts";

const DEFAULT_FILE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

async function readTextFilePreview(
  absolutePath: string,
): Promise<{ contents: string; sizeBytes: number; truncated: boolean }> {
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error("Workspace preview target is not a file.");
  }
  if (fileStat.size > DEFAULT_FILE_PREVIEW_MAX_BYTES) {
    throw new Error("File is too large to preview (maximum 5 MiB).");
  }

  const buffer = Buffer.alloc(fileStat.size);
  const fileHandle = await open(absolutePath, "r");
  try {
    const { bytesRead } = await fileHandle.read(buffer, 0, fileStat.size, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) {
      throw new Error("File is not valid UTF-8 text and cannot be previewed.");
    }
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("File is not valid UTF-8 text and cannot be previewed.");
    }
    return {
      contents,
      sizeBytes: fileStat.size,
      truncated: false,
    };
  } finally {
    await fileHandle.close();
  }
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const readFilePreview: WorkspaceFileSystemShape["readFilePreview"] = Effect.fn(
    "WorkspaceFileSystem.readFilePreview",
  )(function* (input) {
    const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const preview = yield* Effect.tryPromise({
      try: async () => {
        if (isLocalExecutionTarget(executionTargetId)) {
          return readTextFilePreview(target.absolutePath);
        }

        const workspaceTarget = resolveWorkspaceTarget({
          executionTargetId,
          cwd: input.cwd,
        });
        const result = await runToolCommand({
          target: resolveToolTransportTarget(workspaceTarget),
          command: "cat",
          args: [target.relativePath],
          timeoutMs: 30_000,
          maxBufferBytes: DEFAULT_FILE_PREVIEW_MAX_BYTES + 1,
          outputMode: "truncate",
        });
        const bytes = new TextEncoder().encode(result.stdout);
        if (result.stdoutTruncated || bytes.byteLength > DEFAULT_FILE_PREVIEW_MAX_BYTES) {
          throw new Error("File is too large to preview (maximum 5 MiB).");
        }
        if (bytes.includes(0)) {
          throw new Error("File is not valid UTF-8 text and cannot be previewed.");
        }
        let contents: string;
        try {
          contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error("File is not valid UTF-8 text and cannot be previewed.");
        }
        return {
          contents,
          sizeBytes: bytes.byteLength,
          truncated: false,
        };
      },
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: isLocalExecutionTarget(executionTargetId)
            ? "workspaceFileSystem.readFilePreview"
            : "workspaceFileSystem.readFilePreviewRemote",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    return { relativePath: target.relativePath, ...preview };
  });

  const readFileRange = makeWorkspaceFileRange(workspacePaths);

  const searchFileContents: WorkspaceFileSystemShape["searchFileContents"] = Effect.fn(
    "WorkspaceFileSystem.searchFileContents",
  )(function* (input) {
    const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
    if (input.cwd.includes("\0")) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        operation: "workspaceFileSystem.searchFileContents",
        detail: "Workspace root cannot contain NUL bytes.",
      });
    }

    let normalizedWorkspaceRoot = input.cwd;
    if (isLocalExecutionTarget(executionTargetId)) {
      normalizedWorkspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              operation: "workspaceFileSystem.searchFileContents",
              detail: cause.message,
              cause,
            }),
        ),
      );
    }

    const workspaceTarget = resolveWorkspaceTarget({
      executionTargetId,
      cwd: normalizedWorkspaceRoot,
    });
    const toolTransportTarget = resolveToolTransportTarget(workspaceTarget);
    const searchResultOrError = yield* Effect.exit(
      Effect.tryPromise({
        try: () =>
          runToolCommand({
            target: toolTransportTarget,
            command: "rg",
            args: [
              "--json",
              "--hidden",
              "--smart-case",
              ...WORKSPACE_FILE_CONTENT_SEARCH_IGNORED_GLOBS.flatMap((glob) => ["--glob", glob]),
              "--",
              input.query,
              ".",
            ],
            allowNonZeroExit: true,
            timeoutMs: WORKSPACE_FILE_CONTENT_SEARCH_TIMEOUT_MS,
            maxBufferBytes: WORKSPACE_FILE_CONTENT_SEARCH_MAX_BUFFER_BYTES,
            outputMode: "truncate",
          }),
        catch: normalizeSearchCommandError,
      }),
    );

    if (Exit.isFailure(searchResultOrError)) {
      const failure = normalizeSearchCommandError(Cause.squash(searchResultOrError.cause));
      if (isRipgrepCommandNotFound(failure)) {
        if (!isLocalExecutionTarget(executionTargetId)) {
          return yield* new WorkspaceFileSystemError({
            cwd: input.cwd,
            operation: "workspaceFileSystem.searchFileContentsRemote",
            detail: "Remote content search requires ripgrep on the SSH host.",
            cause: failure,
          });
        }
        return yield* Effect.tryPromise({
          try: () =>
            searchFileContentsWithoutRipgrep({
              cwd: normalizedWorkspaceRoot,
              query: input.query,
              limit: input.limit,
            }),
          catch: (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              operation: "workspaceFileSystem.searchFileContentsFallback",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });
      }

      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        operation: "workspaceFileSystem.searchFileContentsCommand",
        detail: failure.message,
        cause: failure,
      });
    }

    const searchResult = searchResultOrError.value;

    if (searchResult.code !== 0 && searchResult.code !== 1) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        operation: "workspaceFileSystem.searchFileContentsCommand",
        detail: searchResult.stderr.trim() || "Workspace file content search failed.",
      });
    }

    const matches = parseRipgrepJsonMatches(searchResult.stdout);
    const limit = Math.max(0, Math.floor(input.limit));
    return {
      matches: matches.slice(0, limit),
      truncated: (searchResult.stdoutTruncated ?? false) || matches.length > limit,
    };
  });

  const watchDirectory: WorkspaceFileSystemShape["watchDirectory"] = Effect.fn(
    "WorkspaceFileSystem.watchDirectory",
  )(function* (input) {
    const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
    if (isLocalExecutionTarget(executionTargetId)) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "workspaceFileSystem.watchDirectory",
        detail: "Local directory watching is owned by the Rust workspace watcher.",
        retryable: false,
      });
    }
    const target = input.relativePath
      ? yield* workspacePaths.resolveRelativePathWithinRoot({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
        })
      : { relativePath: "" };
    return watchRemoteDirectoryViaSsh({
      executionTargetId,
      cwd: input.cwd,
      relativePath: target.relativePath,
    });
  });

  const writeFile = makeWorkspaceWriteFile({ fileSystem, path, workspacePaths, workspaceEntries });
  return {
    readFilePreview,
    readFileRange,
    searchFileContents,
    watchDirectory,
    writeFile,
  } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);

import { Effect, FileSystem, Layer, Path, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { resolveExecutionTargetId } from "@bigbud/contracts";
import { open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceContentSearchOwner } from "../Services/WorkspaceContentSearchOwner.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileReadOwner } from "../Services/WorkspaceFileReadOwner.ts";
import { WorkspaceMutationWatchOwner } from "../Services/WorkspaceMutationWatchOwner.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { runToolCommand, resolveToolTransportTarget } from "../../tool-transport/toolTransport.ts";
import { resolveWorkspaceTarget } from "../../workspace-target/workspaceTarget.ts";
import { searchRemoteFileContentsViaSsh } from "./WorkspaceFileSystem.search.ts";
import { makeWorkspaceFileRange } from "./WorkspaceFileSystem.range.ts";
import { watchRemoteDirectoryViaSsh } from "./WorkspaceFileSystem.remoteWatch.ts";
import { makeWorkspaceWriteFile } from "./WorkspaceFileSystem.write.ts";
import {
  decodeWorkspaceFilePreview,
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
} from "../WorkspaceFilePreview.ts";

async function readTextFilePreview(
  absolutePath: string,
): Promise<{ contents: string; sizeBytes: number; truncated: boolean; sha256: string }> {
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error("Workspace preview target is not a file.");
  }
  if (fileStat.size > WORKSPACE_FILE_PREVIEW_MAX_BYTES) {
    throw new Error("File is too large to preview (maximum 5 MiB).");
  }

  const buffer = Buffer.alloc(fileStat.size);
  const fileHandle = await open(absolutePath, "r");
  try {
    const { bytesRead } = await fileHandle.read(buffer, 0, fileStat.size, 0);
    if (bytesRead !== fileStat.size) throw new Error("File changed while reading preview.");
    const bytes = buffer.subarray(0, bytesRead);
    return {
      contents: decodeWorkspaceFilePreview(bytes),
      sizeBytes: fileStat.size,
      truncated: false,
      sha256: createHash("sha256").update(bytes).digest("hex"),
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
  const workspaceSql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const readOwner = Option.getOrUndefined(yield* Effect.serviceOption(WorkspaceFileReadOwner));
  const contentSearchOwner = Option.getOrUndefined(
    yield* Effect.serviceOption(WorkspaceContentSearchOwner),
  );
  const mutationWatchOwner = Option.getOrUndefined(
    yield* Effect.serviceOption(WorkspaceMutationWatchOwner),
  );

  const readFilePreview: WorkspaceFileSystemShape["readFilePreview"] = Effect.fn(
    "WorkspaceFileSystem.readFilePreview",
  )(function* (input) {
    const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      executionTargetId,
      relativePath: input.relativePath,
    });

    const preview = yield* Effect.tryPromise({
      try: async () => {
        if (isLocalExecutionTarget(executionTargetId)) {
          return readTextFilePreview(target.absolutePath);
        }

        const toolTarget = resolveToolTransportTarget(
          resolveWorkspaceTarget({ executionTargetId, cwd: input.cwd }),
        );
        if (readOwner && toolTarget.transport === "ssh") {
          return readOwner.readFilePreview({
            executionTargetId,
            cwd: input.cwd,
            relativePath: target.relativePath,
          });
        }
        const result = await runToolCommand({
          target: toolTarget,
          command: "cat",
          args: ["--", target.relativePath],
          timeoutMs: 30_000,
          maxBufferBytes: WORKSPACE_FILE_PREVIEW_MAX_BYTES + 1,
          outputMode: "truncate",
        });
        const bytes = new TextEncoder().encode(result.stdout);
        if (result.stdoutTruncated || bytes.byteLength > WORKSPACE_FILE_PREVIEW_MAX_BYTES) {
          throw new Error("File is too large to preview (maximum 5 MiB).");
        }
        return {
          contents: decodeWorkspaceFilePreview(bytes),
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

  const readFileRange = makeWorkspaceFileRange(workspacePaths, readOwner);

  const searchFileContents: WorkspaceFileSystemShape["searchFileContents"] = Effect.fn(
    "WorkspaceFileSystem.searchFileContents",
  )(function* (input) {
    const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
    if (isLocalExecutionTarget(executionTargetId)) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        operation: "workspaceFileSystem.searchFileContents",
        detail: "Local content search is owned by the local workspace agent.",
        retryable: false,
      });
    }
    if (input.cwd.includes("\0")) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        operation: "workspaceFileSystem.searchFileContents",
        detail: "Workspace root cannot contain NUL bytes.",
      });
    }
    return yield* searchRemoteFileContentsViaSsh(
      { ...input, executionTargetId },
      contentSearchOwner,
    );
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
          executionTargetId,
          relativePath: input.relativePath,
        })
      : { relativePath: "" };
    const watchInput = { executionTargetId, cwd: input.cwd, relativePath: target.relativePath };
    const owner =
      mutationWatchOwner &&
      resolveToolTransportTarget(resolveWorkspaceTarget(watchInput)).transport === "ssh"
        ? mutationWatchOwner
        : undefined;
    return watchRemoteDirectoryViaSsh(watchInput, owner);
  });

  const writeFile = makeWorkspaceWriteFile({
    fileSystem,
    path,
    workspacePaths,
    workspaceEntries,
    mutationWatchOwner,
    ...(Option.isSome(workspaceSql) ? { sql: workspaceSql.value } : {}),
  });
  return {
    readFilePreview,
    readFileRange,
    searchFileContents,
    watchDirectory,
    writeFile,
  } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);

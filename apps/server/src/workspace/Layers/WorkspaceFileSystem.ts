import { Duration, Effect, FileSystem, Layer, Path, Stream } from "effect";
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

const DEFAULT_FILE_PREVIEW_MAX_BYTES = 512 * 1024;

async function readTextFilePreview(
  absolutePath: string,
  maxBytes: number,
): Promise<{ contents: string; sizeBytes: number; truncated: boolean }> {
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error("Workspace preview target is not a file.");
  }

  const bytesToRead = Math.min(fileStat.size, maxBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const fileHandle = await open(absolutePath, "r");
  try {
    const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) {
      throw new Error("Binary files cannot be previewed.");
    }
    return {
      contents: new TextDecoder("utf-8").decode(bytes),
      sizeBytes: fileStat.size,
      truncated: fileStat.size > maxBytes,
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

    if (!isLocalExecutionTarget(executionTargetId)) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "workspaceFileSystem.readFilePreviewRemote",
        detail: "Remote workspace file preview is not supported yet.",
      });
    }

    const preview = yield* Effect.tryPromise({
      try: () =>
        readTextFilePreview(target.absolutePath, input.maxBytes ?? DEFAULT_FILE_PREVIEW_MAX_BYTES),
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFilePreview",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    return { relativePath: target.relativePath, ...preview };
  });

  const watchDirectory: WorkspaceFileSystemShape["watchDirectory"] = Effect.fn(
    "WorkspaceFileSystem.watchDirectory",
  )(function* (input) {
    const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath ?? "",
    });

    if (!isLocalExecutionTarget(executionTargetId)) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "workspaceFileSystem.watchDirectoryRemote",
        detail: "Remote workspace directory watching is not supported yet.",
      });
    }

    return fileSystem.watch(target.absolutePath).pipe(
      Stream.debounce(Duration.millis(100)),
      Stream.map(() => ({
        version: 1 as const,
        type: "directoryChanged" as const,
        relativePath: target.relativePath,
      })),
      Stream.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: target.relativePath,
            operation: "workspaceFileSystem.watchDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
  });

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const workspaceTarget = resolveWorkspaceTarget({
      executionTargetId: input.executionTargetId,
      cwd: input.cwd,
    });
    const toolTransportTarget = resolveToolTransportTarget(workspaceTarget);
    const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    if (!isLocalExecutionTarget(executionTargetId)) {
      yield* Effect.tryPromise({
        try: () =>
          runToolCommand({
            target: toolTransportTarget,
            command: "sh",
            args: ["-lc", 'mkdir -p "$(dirname -- "$1")" && cat > "$1"', "sh", target.relativePath],
            stdin: input.contents,
            timeoutMs: 30_000,
            maxBufferBytes: 256 * 1024,
            outputMode: "truncate",
          }),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFileRemote",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      yield* workspaceEntries.invalidate(input.cwd);
      return { relativePath: target.relativePath };
    }

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });
  return { readFilePreview, watchDirectory, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);

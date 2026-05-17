import { Effect, FileSystem, Layer, Path } from "effect";
import { resolveExecutionTargetId } from "@bigbud/contracts";

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

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

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
  return { writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);

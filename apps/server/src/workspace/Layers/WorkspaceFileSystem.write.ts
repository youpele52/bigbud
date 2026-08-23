import { createHash } from "node:crypto";
import { readFile as readFileBytes } from "node:fs/promises";

import { Effect, FileSystem, Path } from "effect";
import { resolveExecutionTargetId } from "@bigbud/contracts/core/baseSchemas.ts";

import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { runToolCommand, resolveToolTransportTarget } from "../../tool-transport/toolTransport.ts";
import { resolveWorkspaceTarget } from "../../workspace-target/workspaceTarget.ts";
import type { WorkspaceEntriesShape } from "../Services/WorkspaceEntries.ts";
import {
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import type { WorkspacePathsShape } from "../Services/WorkspacePaths.ts";

async function currentSha256(absolutePath: string): Promise<string | undefined> {
  try {
    return createHash("sha256")
      .update(await readFileBytes(absolutePath))
      .digest("hex");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

export function makeWorkspaceWriteFile(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workspacePaths: WorkspacePathsShape;
  readonly workspaceEntries: WorkspaceEntriesShape;
}): WorkspaceFileSystemShape["writeFile"] {
  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (value) {
    const workspaceTarget = resolveWorkspaceTarget({
      executionTargetId: value.executionTargetId,
      cwd: value.cwd,
    });
    const toolTransportTarget = resolveToolTransportTarget(workspaceTarget);
    const executionTargetId = resolveExecutionTargetId(value.executionTargetId);
    const target = yield* input.workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: value.cwd,
      relativePath: value.relativePath,
    });

    if (value.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.expectedSha256)) {
      return yield* new WorkspaceFileSystemError({
        cwd: value.cwd,
        relativePath: value.relativePath,
        operation: "workspaceFileSystem.writeFile",
        detail: "expectedSha256 must be a lowercase SHA-256 digest.",
      });
    }

    if (!isLocalExecutionTarget(executionTargetId)) {
      if (value.expectedSha256 !== undefined) {
        return yield* new WorkspaceFileSystemError({
          cwd: value.cwd,
          relativePath: value.relativePath,
          operation: "workspaceFileSystem.writeFileExpectedHashRemote",
          detail: "Conditional remote writes require the remote agent backend.",
        });
      }
      yield* Effect.tryPromise({
        try: () =>
          runToolCommand({
            target: toolTransportTarget,
            command: "sh",
            args: ["-lc", 'mkdir -p "$(dirname -- "$1")" && cat > "$1"', "sh", target.relativePath],
            stdin: value.contents,
            timeoutMs: 30_000,
            maxBufferBytes: 256 * 1024,
            outputMode: "truncate",
          }),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: value.cwd,
            relativePath: value.relativePath,
            operation: "workspaceFileSystem.writeFileRemote",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      yield* input.workspaceEntries.invalidate(value.cwd);
      return { relativePath: target.relativePath };
    }

    if (value.expectedSha256 !== undefined) {
      const actualSha256 = yield* Effect.tryPromise({
        try: () => currentSha256(target.absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: value.cwd,
            relativePath: value.relativePath,
            operation: "workspaceFileSystem.writeFileExpectedHash",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      if (actualSha256 !== value.expectedSha256) {
        return yield* new WorkspaceFileSystemError({
          cwd: value.cwd,
          relativePath: value.relativePath,
          operation: "workspaceFileSystem.writeFileExpectedHash",
          detail: `Workspace file changed since it was read (expected ${value.expectedSha256}, actual ${actualSha256 ?? "missing"}).`,
        });
      }
    }

    yield* input.fileSystem
      .makeDirectory(input.path.dirname(target.absolutePath), { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: value.cwd,
              relativePath: value.relativePath,
              operation: "workspaceFileSystem.makeDirectory",
              detail: cause.message,
              cause,
            }),
        ),
      );
    yield* input.fileSystem.writeFileString(target.absolutePath, value.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: value.cwd,
            relativePath: value.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* input.workspaceEntries.invalidate(value.cwd);
    return { relativePath: target.relativePath };
  });
  return writeFile;
}

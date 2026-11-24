import { writeFile as writeFileBytes } from "node:fs/promises";

import { Effect, FileSystem, Path, Schema, Semaphore } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { withWorktreeAccess } from "../../git/Layers/WorktreeAccess.ts";
import { resolveExecutionTargetId } from "@bigbud/contracts/core/baseSchemas.ts";

import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { runToolCommand, resolveToolTransportTarget } from "../../tool-transport/toolTransport.ts";
import { resolveWorkspaceTarget } from "../../workspace-target/workspaceTarget.ts";
import type { WorkspaceEntriesShape } from "../Services/WorkspaceEntries.ts";
import {
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
  WORKSPACE_FILE_ALREADY_EXISTS,
  WORKSPACE_WRITE_CREATE_ONLY_OPERATION,
} from "../Services/WorkspaceFileSystem.ts";
import type { WorkspacePathsShape } from "../Services/WorkspacePaths.ts";
import {
  ConditionalWriteConflict,
  ConditionalWriteOutcomeUnknown,
  currentSha256,
  replaceConditionalFile,
} from "./WorkspaceFileSystem.write.conditional.ts";

function isAlreadyExists(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
}

export function makeWorkspaceWriteFile(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workspacePaths: WorkspacePathsShape;
  readonly workspaceEntries: WorkspaceEntriesShape;
  readonly sql?: SqlClient.SqlClient;
}): WorkspaceFileSystemShape["writeFile"] {
  // Serialize cooperating local writes across the hash check and mutation.
  const localLocks = new Map<string, { lock: Semaphore.Semaphore; users: number }>();
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
      executionTargetId,
      relativePath: value.relativePath,
    });

    if (value.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.expectedSha256)) {
      return yield* new WorkspaceFileSystemError({
        cwd: value.cwd,
        relativePath: value.relativePath,
        operation: "workspaceFileSystem.writeFile",
        detail: "expectedSha256 must be a lowercase SHA-256 digest.",
        writeDisposition: "not-dispatched",
      });
    }

    if (value.createOnly === true && value.expectedSha256 !== undefined) {
      return yield* new WorkspaceFileSystemError({
        cwd: value.cwd,
        relativePath: value.relativePath,
        operation: "workspaceFileSystem.writeFile",
        detail: "createOnly cannot be combined with expectedSha256.",
        writeDisposition: "not-dispatched",
      });
    }

    if (!isLocalExecutionTarget(executionTargetId)) {
      if (value.createOnly === true) {
        return yield* new WorkspaceFileSystemError({
          cwd: value.cwd,
          relativePath: value.relativePath,
          operation: "workspaceFileSystem.writeFileCreateOnlyRemote",
          detail: "Create-only remote writes are not supported.",
          writeDisposition: "not-dispatched",
        });
      }
      if (value.expectedSha256 !== undefined) {
        return yield* new WorkspaceFileSystemError({
          cwd: value.cwd,
          relativePath: value.relativePath,
          operation: "workspaceFileSystem.writeFileExpectedHashRemote",
          detail: "Conditional remote writes require the remote agent backend.",
          writeDisposition: "not-dispatched",
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
            writeDisposition: "not-dispatched",
            cause,
          }),
      });
      if (actualSha256 !== value.expectedSha256) {
        return yield* new WorkspaceFileSystemError({
          cwd: value.cwd,
          relativePath: value.relativePath,
          operation: "workspaceFileSystem.writeFileExpectedHash",
          detail: `Workspace file changed since it was read (expected ${value.expectedSha256}, actual ${actualSha256 ?? "missing"}).`,
          writeDisposition: "not-dispatched",
          conflict: true,
          ...(actualSha256 ? { currentSha256: actualSha256 } : {}),
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
              writeDisposition: "not-dispatched",
              cause,
            }),
        ),
      );
    const localWriteError = (
      cause: unknown,
      writeDisposition: "terminal" | "unknown" = "unknown",
    ) =>
      new WorkspaceFileSystemError({
        cwd: value.cwd,
        relativePath: value.relativePath,
        operation: "workspaceFileSystem.writeFile",
        detail: cause instanceof Error ? cause.message : String(cause),
        writeDisposition,
        cause,
      });
    if (value.createOnly === true) {
      yield* Effect.tryPromise({
        // `wx` is O_CREAT | O_EXCL: an existing file or symlink fails with EEXIST, untouched.
        try: () =>
          writeFileBytes(target.absolutePath, value.contents, { flag: "wx" }).catch(
            (cause: unknown) => {
              throw isAlreadyExists(cause)
                ? new WorkspaceFileSystemError({
                    cwd: value.cwd,
                    relativePath: value.relativePath,
                    operation: WORKSPACE_WRITE_CREATE_ONLY_OPERATION,
                    detail: WORKSPACE_FILE_ALREADY_EXISTS,
                    writeDisposition: "terminal",
                    cause,
                  })
                : localWriteError(
                    cause,
                    cause instanceof ConditionalWriteOutcomeUnknown ? "unknown" : "terminal",
                  );
            },
          ),
        catch: (cause) =>
          Schema.is(WorkspaceFileSystemError)(cause) ? cause : localWriteError(cause),
      });
      yield* input.workspaceEntries.invalidate(value.cwd);
      return { relativePath: target.relativePath };
    }
    const expectedSha256 = value.expectedSha256;
    if (expectedSha256 !== undefined) {
      // Uninterruptible: the per-path permit must be held until the filesystem work settles, or a
      // retry after an unknown outcome could race the still-running original.
      const written = yield* Effect.uninterruptible(
        Effect.tryPromise({
          // Only an actual rejection of the filesystem promise proves the local write settled.
          try: () =>
            replaceConditionalFile(
              value.cwd,
              target.absolutePath,
              value.contents,
              expectedSha256,
            ).catch((cause: unknown) => {
              throw cause instanceof ConditionalWriteConflict
                ? new WorkspaceFileSystemError({
                    cwd: value.cwd,
                    relativePath: value.relativePath,
                    operation: "workspaceFileSystem.writeFileExpectedHash",
                    detail: `Workspace file changed since it was read (expected ${expectedSha256}, actual ${cause.actualSha256 ?? "missing"}).`,
                    writeDisposition: "not-dispatched",
                    conflict: true,
                    ...(cause.actualSha256 ? { currentSha256: cause.actualSha256 } : {}),
                  })
                : localWriteError(cause, "terminal");
            }),
          catch: (cause) =>
            Schema.is(WorkspaceFileSystemError)(cause) ? cause : localWriteError(cause),
        }),
      );
      yield* input.workspaceEntries.invalidate(value.cwd);
      return { relativePath: target.relativePath, resultSha256: written.resultSha256 };
    }
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
  return (value) => {
    const local = isLocalExecutionTarget(value.executionTargetId);
    const operation =
      input.sql && local
        ? withWorktreeAccess(
            input.sql,
            { cwd: value.cwd, repository: value.cwd },
            writeFile(value),
          ).pipe(
            Effect.mapError((cause) =>
              Schema.is(WorkspaceFileSystemError)(cause)
                ? cause
                : new WorkspaceFileSystemError({
                    cwd: value.cwd,
                    relativePath: value.relativePath,
                    operation: "workspaceFileSystem.writeFile",
                    detail: String(cause),
                    cause,
                  }),
            ),
          )
        : writeFile(value);
    if (!local) return operation;
    return Effect.gen(function* () {
      const key = input.path.join(value.cwd, value.relativePath);
      let reservation = localLocks.get(key);
      if (!reservation) {
        reservation = { lock: yield* Semaphore.make(1), users: 0 };
        localLocks.set(key, reservation);
      }
      reservation.users++;
      const current = reservation;
      return yield* current.lock
        .withPermits(1)(operation)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              current.users--;
              if (current.users === 0) localLocks.delete(key);
            }),
          ),
        );
    });
  };
}

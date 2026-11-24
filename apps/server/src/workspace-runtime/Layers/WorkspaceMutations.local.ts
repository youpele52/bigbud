/**
 * Local Files panel create-folder and delete. Every operation resolves the entry under the real
 * parent directory, which must lie inside the real workspace root; the root itself is refused.
 * Symlinks are never followed: a symlink is removed (or trashed) as a link.
 *
 * The legacy local backend is also reached with `ssh:` (Direct SSH) targets. Those are refused
 * as not dispatched; this module never shells out to a remote host.
 */
import { lstat, mkdir, realpath, rm, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import { Effect } from "effect";
import { resolveExecutionTargetId } from "@bigbud/contracts/core/baseSchemas.ts";
import type {
  ProjectDeleteEntryInput,
  ProjectEntryKindExpectation,
} from "@bigbud/contracts/workspace/projectEntryMutation.ts";
import type { ProjectWriteFileDisposition } from "@bigbud/contracts/workspace/project.ts";

import { isLocalExecutionTarget } from "../../executionTargets.ts";
import type { WorkspaceEntriesShape } from "../../workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystemError } from "../../workspace/Services/WorkspaceFileSystem.ts";
import {
  WorkspacePathOutsideRootError,
  type WorkspacePathsShape,
} from "../../workspace/Services/WorkspacePaths.ts";
import type { WorkspaceTrash } from "../../workspace/Layers/WorkspaceTrash.ts";
import { localBackendFileEdit } from "../fileEditCapability.ts";
import {
  readOnlyEntryActions,
  refuseWorkspaceMutation,
  WORKSPACE_CREATE_DIRECTORY_OPERATION,
  WORKSPACE_DELETE_ENTRY_OPERATION,
  WORKSPACE_ENTRY_ALREADY_EXISTS,
  WORKSPACE_ENTRY_NOT_FOUND,
  type WorkspaceMutationsShape,
} from "../Services/WorkspaceMutations.ts";

const DIRECT_SSH_REFUSAL =
  "Direct SSH projects are read only. Switch this project to the remote agent transport to create or delete files.";

class MutationFailure extends Error {
  constructor(
    readonly detail: string,
    readonly disposition: ProjectWriteFileDisposition,
    readonly outsideRoot = false,
  ) {
    super(detail);
  }
}

const errorCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** The entry path under the real parent, which must be the real root or inside it. */
export async function confinedEntryPath(workspaceRoot: string, absolutePath: string) {
  const realRoot = await realpath(workspaceRoot);
  const name = basename(absolutePath);
  if (name.length === 0 || name === "." || name === "..") {
    throw new MutationFailure("The workspace root cannot be changed.", "not-dispatched", true);
  }
  let realParent: string;
  try {
    realParent = await realpath(dirname(absolutePath));
  } catch (cause) {
    throw new MutationFailure(
      errorCode(cause) === "ENOENT" ? "The folder no longer exists." : describe(cause),
      "not-dispatched",
    );
  }
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (realParent !== realRoot && !realParent.startsWith(rootPrefix)) {
    throw new MutationFailure("The path is outside the workspace.", "not-dispatched", true);
  }
  const entryPath = join(realParent, name);
  if (entryPath === realRoot) {
    throw new MutationFailure("The workspace root cannot be changed.", "not-dispatched", true);
  }
  return entryPath;
}

function kindMismatch(expected: ProjectEntryKindExpectation): MutationFailure {
  return new MutationFailure(
    expected === "file"
      ? "This is now a folder, not a file; nothing was deleted."
      : "This is now a file, not a folder; nothing was deleted.",
    "not-dispatched",
  );
}

async function removeEntry(
  entryPath: string,
  expectedKind: ProjectEntryKindExpectation,
  trash: WorkspaceTrash,
): Promise<"trashed" | "deleted"> {
  const stat = await lstat(entryPath).catch((cause: unknown) => {
    throw errorCode(cause) === "ENOENT"
      ? new MutationFailure(WORKSPACE_ENTRY_NOT_FOUND, "terminal")
      : new MutationFailure(describe(cause), "not-dispatched");
  });
  const link = stat.isSymbolicLink();
  if (!link && stat.isDirectory() !== (expectedKind === "directory")) {
    throw kindMismatch(expectedKind);
  }
  if (trash.available) {
    await trash.moveToTrash(entryPath).catch((cause: unknown) => {
      throw new MutationFailure(describe(cause), "terminal");
    });
    return "trashed";
  }
  if (link || !stat.isDirectory()) {
    await unlink(entryPath)
      .catch(async (cause: unknown) => {
        // Windows removes directory symlinks and junctions with rmdir; that never follows them.
        const code = errorCode(cause);
        if (link && process.platform === "win32" && (code === "EPERM" || code === "EISDIR")) {
          return rmdir(entryPath);
        }
        throw cause;
      })
      .catch((cause: unknown) => {
        throw new MutationFailure(describe(cause), "terminal");
      });
    return "deleted";
  }
  // Recursive rm lstat()s every entry and unlinks symlinks without following them. A failure
  // part-way may leave some contents removed, so its outcome is unknown.
  await rm(entryPath, { recursive: true, force: false }).catch((cause: unknown) => {
    throw new MutationFailure(describe(cause), "unknown");
  });
  return "deleted";
}

export function makeLocalWorkspaceMutations(input: {
  readonly workspacePaths: WorkspacePathsShape;
  readonly workspaceEntries: Pick<WorkspaceEntriesShape, "invalidate">;
  readonly trash: WorkspaceTrash;
}): WorkspaceMutationsShape {
  const run = <A>(
    value: { readonly cwd: string; readonly relativePath: string },
    operation: string,
    executionTargetId: string | undefined,
    perform: (entryPath: string) => Promise<A>,
  ) =>
    Effect.gen(function* () {
      const target = resolveExecutionTargetId(executionTargetId);
      if (!isLocalExecutionTarget(target)) {
        return yield* refuseWorkspaceMutation(value, operation, DIRECT_SSH_REFUSAL);
      }
      const resolved = yield* input.workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: value.cwd,
        executionTargetId: target,
        relativePath: value.relativePath,
      });
      const result = yield* Effect.tryPromise({
        try: async () =>
          perform(await confinedEntryPath(value.cwd, resolved.absolutePath)).then((output) => ({
            output,
            relativePath: resolved.relativePath,
          })),
        catch: (cause) =>
          cause instanceof MutationFailure && cause.outsideRoot
            ? new WorkspacePathOutsideRootError({
                workspaceRoot: value.cwd,
                relativePath: value.relativePath,
              })
            : new WorkspaceFileSystemError({
                cwd: value.cwd,
                relativePath: value.relativePath,
                operation,
                detail: cause instanceof MutationFailure ? cause.detail : describe(cause),
                retryable: false,
                writeDisposition: cause instanceof MutationFailure ? cause.disposition : "unknown",
                cause,
              }),
      });
      yield* input.workspaceEntries.invalidate(value.cwd);
      return result;
    });

  return {
    entryActions: (value) =>
      Effect.sync(() => {
        const edit = localBackendFileEdit(value.executionTargetId);
        if (edit.mode !== "guarded")
          return readOnlyEntryActions(edit.reason ?? "unsupportedTarget");
        return {
          createFile: { allowed: true },
          createFolder: { allowed: true },
          delete: { allowed: true, permanent: !input.trash.available },
        };
      }),
    createDirectory: (value) =>
      run(value, WORKSPACE_CREATE_DIRECTORY_OPERATION, value.executionTargetId, (entryPath) =>
        // Not recursive: the parent must already exist, and an existing entry is never reused.
        mkdir(entryPath).catch((cause: unknown) => {
          throw errorCode(cause) === "EEXIST"
            ? new MutationFailure(WORKSPACE_ENTRY_ALREADY_EXISTS, "terminal")
            : new MutationFailure(describe(cause), "terminal");
        }),
      ).pipe(Effect.map(({ relativePath }) => ({ relativePath }))),
    deleteEntry: (value: ProjectDeleteEntryInput) =>
      run(value, WORKSPACE_DELETE_ENTRY_OPERATION, value.executionTargetId, (entryPath) =>
        removeEntry(entryPath, value.expectedKind, input.trash),
      ).pipe(Effect.map(({ output, relativePath }) => ({ relativePath, disposition: output }))),
  };
}

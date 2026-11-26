import * as Effect from "effect/Effect";

import { SshOwnerDevPickerError } from "../ssh/sshOwnerDevPicker.errors.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.client.ts";
import type { PickerProofWorkspaceClient } from "../ssh/sshOwnerPickerProof.client.workspace.ts";
import { MAX_WORKSPACE_STAGED_WRITE_BYTES } from "../ssh/sshOwnerPickerProof.codec.workspace.mutation.ts";
import { RemoteTargetDisconnectedError } from "../ssh/sshTargetDisconnects.ts";
import {
  workspaceContentSearchForPickerProof,
  workspaceDirectoryForPickerProof,
  workspaceIndexForPickerProof,
  workspaceMutationWatchForPickerProof,
  workspaceReadsForPickerProof,
} from "../ssh/sshOwnerPickerProof.workspace.ts";
import type { WorkspaceFilesShape } from "../workspace-runtime/Services/WorkspaceFiles.ts";
import type { WorkspaceRuntimeShape } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import { IGNORED_DIRECTORY_NAMES } from "../workspace/Layers/WorkspaceEntries.constants.ts";
import {
  buildOwnedRemoteWorkspaceIndex,
  listRemoteWorkspaceDirectory,
} from "../workspace/Layers/WorkspaceEntries.remote.ts";
import { limitSearchResult } from "../workspace/Layers/WorkspaceFileSystem.search.ts";
import { watchRemoteDirectoryViaSsh } from "../workspace/Layers/WorkspaceFileSystem.remoteWatch.ts";
import {
  isPathInIgnoredDirectory,
  rankWorkspaceIndex,
  toSearchableWorkspaceEntry,
} from "../workspace/Layers/WorkspaceEntriesSearch.ts";
import type { WorkspaceDirectoryReadOwnerShape } from "../workspace/Services/WorkspaceDirectoryReadOwner.ts";
import { WorkspaceEntriesError } from "../workspace/Services/WorkspaceEntries.ts";
import type { WorkspaceFileReadOwnerShape } from "../workspace/Services/WorkspaceFileReadOwner.ts";
import { WorkspaceFileSystemError } from "../workspace/Services/WorkspaceFileSystem.ts";
import {
  WorkspacePathOutsideRootError,
  WorkspacePaths,
} from "../workspace/Services/WorkspacePaths.ts";

import {
  guardedPreview,
  writeGuardedDevWorkspaceFile,
  type SelectedGuardedWorkspaceWrite,
} from "./wsSshOwnerDev.workspace.guarded.ts";

import {
  createDevWorkspaceFile,
  isFixture,
  isWsSshOwnerWorkspaceTarget,
  type SelectedExclusiveWorkspaceCreate,
} from "./wsSshOwnerDev.workspace.create.ts";

export interface SshOwnerWorkspaceBinding {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly guardedWrite?: SelectedGuardedWorkspaceWrite;
  readonly exclusiveCreate?: SelectedExclusiveWorkspaceCreate;
  readonly pendingCreateQualification?: () => Promise<void> | undefined;
  readonly withOwner: <A>(
    targetId: string,
    use: (owner: PickerProofWorkspaceClient) => Promise<A>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

/** The binding serving one request, or the typed refusal detail. */
export type SshOwnerWorkspaceBindingFor = (input: {
  readonly cwd: string;
  readonly executionTargetId?: string | undefined;
}) => SshOwnerWorkspaceBinding | string;

type WorkspaceInput = { readonly cwd: string; readonly executionTargetId?: string | undefined };
type FileInput = WorkspaceInput & { readonly relativePath: string };
type OwnerFileInput = Parameters<WorkspaceFileReadOwnerShape["readFilePreview"]>[0];

const unsupported = "This operation is unavailable in Rust SSH owner development mode.";
const fixtureOnly =
  "Rust SSH owner workspace reads require the exact development fixture target and root.";
const errorDetail = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const entriesError = (input: WorkspaceInput, operation: string, detail: string, cause?: unknown) =>
  new WorkspaceEntriesError({
    cwd: input.cwd,
    operation,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const fileError = (
  input: WorkspaceInput & { readonly relativePath?: string | undefined },
  operation: string,
  detail: string,
  cause?: unknown,
) =>
  new WorkspaceFileSystemError({
    cwd: input.cwd,
    operation,
    detail,
    ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }),
    ...(cause === undefined ? { retryable: false } : { cause }),
  });

function projectDirectoryEntries(
  relativeDir: string,
  entries: Awaited<ReturnType<WorkspaceDirectoryReadOwnerShape["listDirectory"]>>["entries"],
) {
  return listRemoteWorkspaceDirectory(
    entries.flatMap(({ name, directory }) => {
      if (!name || name === "." || name === ".." || /[/\\]/.test(name) || name.includes("\0")) {
        return [];
      }
      const path = relativeDir ? `${relativeDir}/${name}` : name;
      return isPathInIgnoredDirectory(path, IGNORED_DIRECTORY_NAMES)
        ? []
        : [
            toSearchableWorkspaceEntry({
              path,
              kind: directory ? "directory" : "file",
              ...(relativeDir ? { parentPath: relativeDir } : {}),
            }),
          ];
    }),
    relativeDir,
  );
}

/** Only installed for the selected normal-dev WebSocket route. Never dispatch SSH to its default runtime. */
export const withWsSshOwnerDevWorkspace = (
  runtime: WorkspaceRuntimeShape,
  binding: SshOwnerWorkspaceBinding | undefined,
) =>
  withWsSshOwnerWorkspace(runtime, (input) =>
    !binding ? unsupported : isFixture(input, binding) ? binding : fixtureOnly,
  );

/**
 * Routes every `ssh:` workspace request through the binding chosen for that
 * request (the dev fixture, or the production owner's exact target), never the
 * default runtime's legacy SSH path.
 */
export const withWsSshOwnerWorkspace = Effect.fn("withWsSshOwnerWorkspace")(function* (
  runtime: WorkspaceRuntimeShape,
  bindingFor: SshOwnerWorkspaceBindingFor,
) {
  const paths = yield* WorkspacePaths;
  const resolvePath = (relativePath: string, binding: SshOwnerWorkspaceBinding) => {
    const workspaceRoot = binding.workspaceRoot;
    // WorkspacePaths emits POSIX-style output; do not let it alias literal backslashes.
    if (relativePath.includes("\\")) {
      return Effect.fail(new WorkspacePathOutsideRootError({ workspaceRoot, relativePath }));
    }
    return paths.resolveRelativePathWithinRoot({
      workspaceRoot,
      executionTargetId: binding.targetId,
      relativePath,
    });
  };

  const listDirectory: WorkspaceFilesShape["listDirectory"] = Effect.fn(
    "WsSshOwnerWorkspace.listDirectory",
  )(function* (input) {
    if (!isWsSshOwnerWorkspaceTarget(input.executionTargetId)) {
      return yield* runtime.files.listDirectory(input);
    }
    const operation = "workspaceEntries.remoteDirectory";
    const binding = bindingFor(input);
    if (typeof binding === "string") return yield* entriesError(input, operation, binding);
    const requested = input.relativePath ?? "";
    // The root itself is listable but not a valid file path in WorkspacePaths.
    const relativeDir =
      requested === "" || requested === "." || requested === "./"
        ? ""
        : (yield* resolvePath(requested, binding).pipe(
            Effect.mapError((cause) =>
              entriesError(input, "workspaceEntries.remoteDirectoryPath", cause.message, cause),
            ),
          )).relativePath;
    const { entries, truncated } = yield* Effect.tryPromise({
      try: () =>
        binding.withOwner(binding.targetId, (owner) =>
          workspaceDirectoryForPickerProof(owner).listDirectory({
            cwd: binding.workspaceRoot,
            executionTargetId: binding.targetId,
            relativeDir,
          }),
        ),
      catch: (cause) => entriesError(input, operation, errorDetail(cause), cause),
    });
    if (truncated)
      return yield* entriesError(
        input,
        operation,
        "The remote directory listing exceeded its limit; the result is incomplete.",
      );
    return { entries: projectDirectoryEntries(relativeDir, entries) };
  });

  const readFile = <A>(
    input: FileInput,
    operation: string,
    read: (files: WorkspaceFileReadOwnerShape, request: OwnerFileInput) => Promise<A>,
  ) =>
    Effect.gen(function* () {
      const binding = bindingFor(input);
      if (typeof binding === "string") return yield* fileError(input, operation, binding);
      const { relativePath } = yield* resolvePath(input.relativePath, binding);
      const result = yield* Effect.tryPromise({
        try: () =>
          binding.withOwner(binding.targetId, (owner) =>
            read(workspaceReadsForPickerProof(owner), {
              cwd: binding.workspaceRoot,
              executionTargetId: binding.targetId,
              relativePath,
            }),
          ),
        catch: (cause) => fileError(input, operation, errorDetail(cause), cause),
      });
      return { ...result, relativePath };
    });
  // The guarded-write capability of the binding that served this exact request.
  const guardedWriteFor = (input: WorkspaceInput) => {
    const binding = bindingFor(input);
    return typeof binding === "string" ? undefined : binding.guardedWrite;
  };

  return {
    files: {
      listDirectory,
      readFilePreview: (input) =>
        isWsSshOwnerWorkspaceTarget(input.executionTargetId)
          ? readFile(input, "workspaceFileSystem.readFilePreviewRemote", (files, request) =>
              files.readFilePreview(request),
            ).pipe(Effect.map((preview) => guardedPreview(preview, guardedWriteFor(input))))
          : runtime.files.readFilePreview(input),
      readFileRange: (input) =>
        isWsSshOwnerWorkspaceTarget(input.executionTargetId)
          ? readFile(input, "workspaceFileSystem.readFileRangeRemote", (files, request) =>
              files.readFileRange({
                ...request,
                offset: Math.max(0, Math.floor(input.offset)),
                maxBytes: Math.min(512 * 1024, Math.max(0, Math.floor(input.maxBytes))),
              }),
            )
          : runtime.files.readFileRange(input),
      writeFile: (input) =>
        isWsSshOwnerWorkspaceTarget(input.executionTargetId)
          ? Effect.gen(function* () {
              const operation = "workspaceFileSystem.writeFileRemote";
              const refuse = (detail: string) =>
                new WorkspaceFileSystemError({
                  cwd: input.cwd,
                  relativePath: input.relativePath,
                  operation,
                  detail,
                  retryable: false,
                  writeDisposition: "not-dispatched",
                });
              const binding = bindingFor(input);
              if (typeof binding === "string") return yield* refuse(binding);
              if (input.createOnly) {
                const create = binding.exclusiveCreate;
                if (!create)
                  return yield* refuse("This SSH owner cannot perform create-only writes.");
                const { relativePath } = yield* resolvePath(input.relativePath, binding);
                return yield* createDevWorkspaceFile(input, relativePath, create);
              }
              if (input.expectedSha256 !== undefined) {
                if (!binding.guardedWrite)
                  return yield* refuse("This SSH owner cannot perform guarded writes.");
                const { relativePath } = yield* resolvePath(input.relativePath, binding);
                return yield* writeGuardedDevWorkspaceFile(
                  input,
                  relativePath,
                  binding.guardedWrite,
                );
              }
              // Bytes are UTF-8 encoded once; the typed client stages anything
              // above the single-frame 48 KiB limit up to 512 KiB.
              const contents = new TextEncoder().encode(input.contents);
              if (contents.byteLength > MAX_WORKSPACE_STAGED_WRITE_BYTES)
                return yield* refuse("The SSH owner write limit is 512 KiB.");
              const { relativePath } = yield* resolvePath(input.relativePath, binding);
              let enteredOwner = false;
              yield* Effect.tryPromise({
                try: () =>
                  binding.withOwner(binding.targetId, (owner) => {
                    enteredOwner = true;
                    return owner.writeProofWorkspaceFile({
                      executionTargetId: binding.targetId,
                      workspaceRoot: binding.workspaceRoot,
                      relativePath,
                      contents,
                    });
                  }),
                catch: (cause) => {
                  const code =
                    cause instanceof SshOwnerDevPickerError ||
                    cause instanceof PickerProofOwnerError
                      ? cause.code
                      : undefined;
                  const terminal =
                    code === "workspaceWriteFailed" || code === "workspacePathDenied";
                  return new WorkspaceFileSystemError({
                    cwd: input.cwd,
                    relativePath,
                    operation,
                    detail: errorDetail(cause),
                    cause,
                    retryable: false,
                    writeDisposition:
                      !enteredOwner ||
                      cause instanceof RemoteTargetDisconnectedError ||
                      code === "targetDisconnected"
                        ? "not-dispatched"
                        : terminal
                          ? "terminal"
                          : "unknown",
                  });
                },
              });
              return { relativePath };
            })
          : runtime.files.writeFile(input),
    },
    search: {
      searchEntries: (input) =>
        isWsSshOwnerWorkspaceTarget(input.executionTargetId)
          ? Effect.gen(function* () {
              const binding = bindingFor(input);
              if (typeof binding === "string")
                return yield* entriesError(input, "workspaceEntries.search", binding);
              const index = yield* buildOwnedRemoteWorkspaceIndex(
                { cwd: binding.workspaceRoot, executionTargetId: binding.targetId },
                {
                  indexWorkspace: (request) =>
                    binding.withOwner(binding.targetId, (owner) =>
                      workspaceIndexForPickerProof(owner).indexWorkspace(request),
                    ),
                },
              );
              return rankWorkspaceIndex(index, input);
            })
          : runtime.search.searchEntries(input),
      searchFileContents: (input) =>
        isWsSshOwnerWorkspaceTarget(input.executionTargetId)
          ? Effect.gen(function* () {
              const operation = "workspaceFileSystem.searchFileContentsRemote";
              const binding = bindingFor(input);
              if (typeof binding === "string") return yield* fileError(input, operation, binding);
              const result = yield* Effect.tryPromise({
                try: (signal) =>
                  binding.withOwner(
                    binding.targetId,
                    (owner) =>
                      workspaceContentSearchForPickerProof(owner).searchFileContents({
                        ...input,
                        cwd: binding.workspaceRoot,
                        executionTargetId: binding.targetId,
                      }),
                    signal,
                  ),
                catch: (cause) => fileError(input, operation, errorDetail(cause), cause),
              });
              return limitSearchResult(result, input.limit);
            })
          : runtime.search.searchFileContents(input),
    },
    watch: {
      watchDirectory: (input) =>
        isWsSshOwnerWorkspaceTarget(input.executionTargetId)
          ? Effect.gen(function* () {
              const operation = "workspaceFileSystem.watchDirectory";
              const binding = bindingFor(input);
              if (typeof binding === "string") return yield* fileError(input, operation, binding);
              const relativePath = input.relativePath
                ? (yield* resolvePath(input.relativePath, binding)).relativePath
                : "";
              return watchRemoteDirectoryViaSsh(
                { executionTargetId: binding.targetId, cwd: binding.workspaceRoot, relativePath },
                {
                  snapshotDirectory: (request, signal) =>
                    binding.withOwner(
                      binding.targetId,
                      (owner) =>
                        workspaceMutationWatchForPickerProof(owner).snapshotDirectory(
                          request,
                          signal,
                        ),
                      signal,
                    ),
                },
              );
            })
          : runtime.watch.watchDirectory(input),
    },
  } satisfies WorkspaceRuntimeShape;
});

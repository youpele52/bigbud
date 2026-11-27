import * as Effect from "effect/Effect";

import { SshOwnerOperationError } from "../ssh/sshOwnerOperation.errors.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.client.ts";
import {
  isWorkspaceWriteContents,
  MAX_WORKSPACE_WRITE_BYTES,
} from "../ssh/sshOwnerPickerProof.codec.workspace.ts";
import { RemoteTargetDisconnectedError } from "../ssh/sshTargetDisconnects.ts";
import {
  readOnlyEntryActions,
  unsupportedWorkspaceMutations,
  type WorkspaceMutationsShape,
} from "../workspace-runtime/Services/WorkspaceMutations.ts";
import type { WorkspaceFilesShape } from "../workspace-runtime/Services/WorkspaceFiles.ts";
import {
  WORKSPACE_FILE_ALREADY_EXISTS,
  WORKSPACE_WRITE_CREATE_ONLY_OPERATION,
  WorkspaceFileSystemError,
} from "../workspace/Services/WorkspaceFileSystem.ts";
import { withSelectedEntryMutations } from "./wsSshOwnerDev.workspace.entries.ts";

export interface SelectedExclusiveWorkspaceCreate {
  readonly apply: (input: {
    readonly relativePath: string;
    readonly contents: Uint8Array;
  }) => Promise<"created" | "alreadyExists" | "notQualified">;
}

export interface ScopedCreateBinding {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly exclusiveCreate?: SelectedExclusiveWorkspaceCreate;
  readonly pendingCreateQualification?: () => Promise<void> | undefined;
  readonly withOwner?: <A>(
    targetId: string,
    use: (owner: {
      createProofWorkspaceDirectory(input: {
        executionTargetId: string;
        workspaceRoot: string;
        relativePath: string;
      }): Promise<"created" | "alreadyExists">;
      deleteProofWorkspaceEntry(input: {
        executionTargetId: string;
        workspaceRoot: string;
        relativePath: string;
        expectedDirectory: boolean;
      }): Promise<"deleted" | "notFound">;
    }) => Promise<A>,
  ) => Promise<A>;
}

const CREATE_QUALIFICATION_WAIT = "5 seconds";

export const isWsSshOwnerWorkspaceTarget = (executionTargetId: string | undefined): boolean =>
  executionTargetId?.startsWith("ssh:") ?? false;

export const isFixture = (
  input: { readonly cwd: string; readonly executionTargetId?: string | undefined },
  scope: ScopedCreateBinding,
) => input.executionTargetId === scope.targetId && input.cwd === scope.workspaceRoot;

export function withWsSshOwnerDevEntryActions(
  mutations: WorkspaceMutationsShape | undefined,
  binding: ScopedCreateBinding | undefined,
): WorkspaceMutationsShape {
  return withWsSshOwnerEntryActions(mutations, (input) =>
    binding && isFixture(input, binding) ? binding : undefined,
  );
}

/** Entry actions and folder mutations served by the binding chosen for each request. */
export function withWsSshOwnerEntryActions(
  mutations: WorkspaceMutationsShape | undefined,
  bindingFor: (input: {
    readonly cwd: string;
    readonly executionTargetId?: string | undefined;
  }) => ScopedCreateBinding | undefined,
): WorkspaceMutationsShape {
  const backend = mutations ?? unsupportedWorkspaceMutations;
  const disabled = readOnlyEntryActions("unsupportedTarget");
  const withEntries = withSelectedEntryMutations(
    {
      ...backend,
      entryActions: (input) =>
        Effect.gen(function* () {
          const actions = yield* backend.entryActions(input);
          if (!isWsSshOwnerWorkspaceTarget(input.executionTargetId)) return actions;
          const fixture = bindingFor(input);
          const pending = fixture?.exclusiveCreate
            ? undefined
            : fixture?.pendingCreateQualification?.();
          if (pending) {
            // Interrupting this waiter never interrupts the owner operation it observes.
            yield* Effect.promise(() => pending).pipe(
              Effect.timeoutOption(CREATE_QUALIFICATION_WAIT),
            );
          }
          const fixtureOwner = fixture?.withOwner ? fixture : undefined;
          return {
            ...actions,
            createFile: fixture?.exclusiveCreate ? { allowed: true } : disabled.createFile,
            createFolder: fixtureOwner ? { allowed: true } : disabled.createFolder,
            delete: fixtureOwner ? { allowed: true, permanent: true } : disabled.delete,
          };
        }),
    },
    bindingFor,
  );
  return withEntries;
}

export function createDevWorkspaceFile(
  input: Parameters<WorkspaceFilesShape["writeFile"]>[0],
  relativePath: string,
  create: SelectedExclusiveWorkspaceCreate,
) {
  return Effect.gen(function* () {
    const fail = (
      detail: string,
      writeDisposition: "not-dispatched" | "terminal" | "unknown",
      cause?: unknown,
    ) =>
      new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath,
        operation: WORKSPACE_WRITE_CREATE_ONLY_OPERATION,
        detail,
        cause,
        retryable: false,
        writeDisposition,
      });
    if (input.expectedSha256 !== undefined)
      return yield* fail("createOnly cannot be combined with expectedSha256.", "not-dispatched");
    const limit = "The SSH owner create limit is 48 KiB.";
    if (input.contents.length > MAX_WORKSPACE_WRITE_BYTES)
      return yield* fail(limit, "not-dispatched");
    const contents = new TextEncoder().encode(input.contents);
    if (!isWorkspaceWriteContents(contents)) return yield* fail(limit, "not-dispatched");
    const result = yield* Effect.tryPromise({
      try: () => create.apply({ relativePath, contents }),
      catch: (cause) => {
        const code =
          cause instanceof PickerProofOwnerError || cause instanceof SshOwnerOperationError
            ? cause.code
            : undefined;
        const disposition =
          cause instanceof RemoteTargetDisconnectedError ||
          code === "targetDisconnected" ||
          code === "invalidOperands"
            ? "not-dispatched"
            : code === "workspacePathDenied"
              ? "terminal"
              : "unknown";
        return fail(cause instanceof Error ? cause.message : String(cause), disposition, cause);
      },
    });
    if (result === "notQualified")
      return yield* fail(
        "The selected SSH owner is not qualified for exclusive create.",
        "not-dispatched",
      );
    if (result === "alreadyExists") return yield* fail(WORKSPACE_FILE_ALREADY_EXISTS, "terminal");
    return { relativePath };
  });
}

import * as Effect from "effect/Effect";

import { SshOwnerDevPickerError } from "../ssh/sshOwnerDevPicker.errors.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.client.ts";
import { validRelativeOperand } from "../ssh/sshOwnerPickerProof.codec.workspace.ts";
import { RemoteTargetDisconnectedError } from "../ssh/sshTargetDisconnects.ts";
import {
  WORKSPACE_CREATE_DIRECTORY_OPERATION,
  WORKSPACE_DELETE_ENTRY_OPERATION,
  WORKSPACE_ENTRY_ALREADY_EXISTS,
  WORKSPACE_ENTRY_NOT_FOUND,
  type WorkspaceMutationsShape,
} from "../workspace-runtime/Services/WorkspaceMutations.ts";
import { WorkspaceFileSystemError } from "../workspace/Services/WorkspaceFileSystem.ts";

interface EntryOwner {
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
}

export interface SelectedEntryMutationBinding {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly withOwner?: <A>(targetId: string, use: (owner: EntryOwner) => Promise<A>) => Promise<A>;
}

interface EntryInput {
  readonly executionTargetId?: string | undefined;
  readonly cwd: string;
  readonly relativePath: string;
}

const isFixture = (input: EntryInput, binding: SelectedEntryMutationBinding) =>
  input.executionTargetId === binding.targetId && input.cwd === binding.workspaceRoot;

const errorDetail = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function requireOwner(fixture: SelectedEntryMutationBinding) {
  const withOwner = fixture.withOwner;
  if (!withOwner) throw new Error("The selected SSH owner capability is not bound.");
  return withOwner;
}

function failure(
  input: EntryInput,
  operation: string,
  detail: string,
  writeDisposition: "not-dispatched" | "terminal" | "unknown",
  cause?: unknown,
) {
  return new WorkspaceFileSystemError({
    cwd: input.cwd,
    relativePath: input.relativePath,
    operation,
    detail,
    retryable: false,
    writeDisposition,
    ...(cause === undefined ? {} : { cause }),
  });
}

function ownerFailure(
  input: EntryInput,
  operation: string,
  cause: unknown,
): WorkspaceFileSystemError {
  const code =
    cause instanceof PickerProofOwnerError || cause instanceof SshOwnerDevPickerError
      ? cause.code
      : undefined;
  const disposition =
    cause instanceof RemoteTargetDisconnectedError ||
    code === "targetDisconnected" ||
    code === "invalidOperands" ||
    code === "workspacePathDenied"
      ? "not-dispatched"
      : "unknown";
  return failure(input, operation, errorDetail(cause), disposition, cause);
}

/** Folder create and permanent delete for the exact selected fixture target/root only. */
export function withSelectedEntryMutations(
  backend: WorkspaceMutationsShape,
  bindingFor: (input: EntryInput) => SelectedEntryMutationBinding | undefined,
): WorkspaceMutationsShape {
  const selected = (input: EntryInput): SelectedEntryMutationBinding | undefined => {
    const binding = bindingFor(input);
    return binding?.withOwner && isFixture(input, binding) ? binding : undefined;
  };
  const unsupported = (input: EntryInput, operation: string) =>
    failure(
      input,
      operation,
      "This operation is unavailable in Rust SSH owner development mode.",
      "not-dispatched",
    );

  return {
    ...backend,
    createDirectory: (input) =>
      Effect.gen(function* () {
        const fixture = selected(input);
        if (!fixture) {
          if (input.executionTargetId?.startsWith("ssh:"))
            return yield* unsupported(input, WORKSPACE_CREATE_DIRECTORY_OPERATION);
          return yield* backend.createDirectory(input);
        }
        if (!validRelativeOperand(input.relativePath) || input.relativePath.includes("\\"))
          return yield* failure(
            input,
            WORKSPACE_CREATE_DIRECTORY_OPERATION,
            "The folder path must stay inside the workspace root.",
            "not-dispatched",
          );
        const result = yield* Effect.tryPromise({
          try: () =>
            requireOwner(fixture)(fixture.targetId, (owner) =>
              owner.createProofWorkspaceDirectory({
                executionTargetId: fixture.targetId,
                workspaceRoot: fixture.workspaceRoot,
                relativePath: input.relativePath,
              }),
            ),
          catch: (cause) => ownerFailure(input, WORKSPACE_CREATE_DIRECTORY_OPERATION, cause),
        });
        if (result === "alreadyExists")
          return yield* failure(
            input,
            WORKSPACE_CREATE_DIRECTORY_OPERATION,
            WORKSPACE_ENTRY_ALREADY_EXISTS,
            "terminal",
          );
        return { relativePath: input.relativePath };
      }),
    deleteEntry: (input) =>
      Effect.gen(function* () {
        const fixture = selected(input);
        if (!fixture) {
          if (input.executionTargetId?.startsWith("ssh:"))
            return yield* unsupported(input, WORKSPACE_DELETE_ENTRY_OPERATION);
          return yield* backend.deleteEntry(input);
        }
        if (!validRelativeOperand(input.relativePath) || input.relativePath.includes("\\"))
          return yield* failure(
            input,
            WORKSPACE_DELETE_ENTRY_OPERATION,
            "The entry path must stay inside the workspace root.",
            "not-dispatched",
          );
        const expectedDirectory: boolean = input.expectedKind === "directory";
        const result = yield* Effect.tryPromise({
          try: () =>
            requireOwner(fixture)(fixture.targetId, (owner) =>
              owner.deleteProofWorkspaceEntry({
                executionTargetId: fixture.targetId,
                workspaceRoot: fixture.workspaceRoot,
                relativePath: input.relativePath,
                expectedDirectory,
              }),
            ),
          catch: (cause) => ownerFailure(input, WORKSPACE_DELETE_ENTRY_OPERATION, cause),
        });
        if (result === "notFound")
          return yield* failure(
            input,
            WORKSPACE_DELETE_ENTRY_OPERATION,
            WORKSPACE_ENTRY_NOT_FOUND,
            "terminal",
          );
        return { relativePath: input.relativePath, disposition: "deleted" as const };
      }),
  };
}

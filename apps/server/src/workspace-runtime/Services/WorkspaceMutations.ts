/**
 * Files panel create-folder and delete operations, plus the per-workspace capability that tells
 * the UI which of create file, create folder and delete the composed backend allows.
 *
 * Kept apart from `WorkspaceFiles` so routers that wrap file reads (the dev SSH-owner router)
 * cannot silently drop or redirect these destructive operations.
 */
import { Effect } from "effect";

import type {
  ProjectCreateDirectoryInput,
  ProjectCreateDirectoryResult,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectEntryActions,
  ProjectEntryActionsInput,
} from "@bigbud/contracts/workspace/projectEntryMutation.ts";
import type { ProjectFileEditReadOnlyReason } from "@bigbud/contracts/workspace/project.ts";
import { WorkspaceFileSystemError } from "../../workspace/Services/WorkspaceFileSystem.ts";
import type { WorkspacePathOutsideRootError } from "../../workspace/Services/WorkspacePaths.ts";

export const WORKSPACE_CREATE_DIRECTORY_OPERATION = "workspaceMutations.createDirectory";
export const WORKSPACE_DELETE_ENTRY_OPERATION = "workspaceMutations.deleteEntry";
/** Details the RPC layer maps to `alreadyExists` / `notFound`; messages are not parsed. */
export const WORKSPACE_ENTRY_ALREADY_EXISTS = "A file or folder with that name already exists.";
export const WORKSPACE_ENTRY_NOT_FOUND = "The file or folder no longer exists.";

export type WorkspaceMutationError = WorkspaceFileSystemError | WorkspacePathOutsideRootError;

export interface WorkspaceMutationsShape {
  readonly entryActions: (input: ProjectEntryActionsInput) => Effect.Effect<ProjectEntryActions>;
  readonly createDirectory: (
    input: ProjectCreateDirectoryInput,
  ) => Effect.Effect<ProjectCreateDirectoryResult, WorkspaceMutationError>;
  readonly deleteEntry: (
    input: ProjectDeleteEntryInput,
  ) => Effect.Effect<ProjectDeleteEntryResult, WorkspaceMutationError>;
}

export const readOnlyEntryActions = (
  reason: ProjectFileEditReadOnlyReason,
): ProjectEntryActions => ({
  createFile: { allowed: false, reason },
  createFolder: { allowed: false, reason },
  delete: { allowed: false, reason, permanent: true },
});

/** Refusal for a backend that cannot perform the operation; nothing was sent or changed. */
export function refuseWorkspaceMutation(
  input: { readonly cwd: string; readonly relativePath: string },
  operation: string,
  detail: string,
): WorkspaceFileSystemError {
  return new WorkspaceFileSystemError({
    cwd: input.cwd,
    relativePath: input.relativePath,
    operation,
    detail,
    retryable: false,
    writeDisposition: "not-dispatched",
  });
}

/** Used when a composed backend provides no mutations (for example a test or legacy runtime). */
export const unsupportedWorkspaceMutations: WorkspaceMutationsShape = {
  entryActions: () => Effect.succeed(readOnlyEntryActions("unsupportedTarget")),
  createDirectory: (input) =>
    Effect.fail(
      refuseWorkspaceMutation(
        input,
        WORKSPACE_CREATE_DIRECTORY_OPERATION,
        "Creating folders isn't supported for this location.",
      ),
    ),
  deleteEntry: (input) =>
    Effect.fail(
      refuseWorkspaceMutation(
        input,
        WORKSPACE_DELETE_ENTRY_OPERATION,
        "Deleting isn't supported for this location.",
      ),
    ),
};

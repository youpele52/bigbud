import { Effect, Schema } from "effect";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type {
  ProjectCreateDirectoryInput,
  ProjectDeleteEntryInput,
  ProjectEntryActionsInput,
} from "@bigbud/contracts/workspace/projectEntryMutation.ts";
import { ProjectEntryMutationError } from "@bigbud/contracts/workspace/projectEntryMutation.ts";

import { observeRpcEffect } from "../observability/RpcInstrumentation";
import {
  unsupportedWorkspaceMutations,
  WORKSPACE_ENTRY_ALREADY_EXISTS,
  WORKSPACE_ENTRY_NOT_FOUND,
  type WorkspaceMutationError,
  type WorkspaceMutationsShape,
} from "../workspace-runtime/Services/WorkspaceMutations";
import { WorkspaceFileSystemError } from "../workspace/Services/WorkspaceFileSystem";
import { WorkspacePathOutsideRootError } from "../workspace/Services/WorkspacePaths";

export function projectEntryMutationError(
  cause: WorkspaceMutationError,
  fallback: string,
): ProjectEntryMutationError {
  if (Schema.is(WorkspacePathOutsideRootError)(cause)) {
    return new ProjectEntryMutationError({
      message: "Workspace file path must stay within the project root.",
      mutationDisposition: "not-dispatched",
      cause,
    });
  }
  const alreadyExists =
    Schema.is(WorkspaceFileSystemError)(cause) && cause.detail === WORKSPACE_ENTRY_ALREADY_EXISTS;
  const notFound =
    Schema.is(WorkspaceFileSystemError)(cause) && cause.detail === WORKSPACE_ENTRY_NOT_FOUND;
  const detail = cause.detail.trim();
  return new ProjectEntryMutationError({
    message: detail.length > 0 ? detail : fallback,
    ...(alreadyExists ? { alreadyExists: true } : {}),
    ...(notFound ? { notFound: true } : {}),
    ...(cause.writeDisposition ? { mutationDisposition: cause.writeDisposition } : {}),
    cause,
  });
}

/** Files create-folder and delete RPCs; a context without mutations refuses them. */
export function makeWorkspaceEntryWsRpcHandlers(mutations: WorkspaceMutationsShape | undefined) {
  const backend = mutations ?? unsupportedWorkspaceMutations;
  return {
    [WS_METHODS.projectsEntryActions]: (input: ProjectEntryActionsInput) =>
      observeRpcEffect(WS_METHODS.projectsEntryActions, backend.entryActions(input), {
        "rpc.aggregate": "workspace",
      }),
    [WS_METHODS.projectsCreateDirectory]: (input: ProjectCreateDirectoryInput) =>
      observeRpcEffect(
        WS_METHODS.projectsCreateDirectory,
        backend
          .createDirectory(input)
          .pipe(
            Effect.mapError((cause) => projectEntryMutationError(cause, "Failed to create folder")),
          ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsDeleteEntry]: (input: ProjectDeleteEntryInput) =>
      observeRpcEffect(
        WS_METHODS.projectsDeleteEntry,
        backend
          .deleteEntry(input)
          .pipe(Effect.mapError((cause) => projectEntryMutationError(cause, "Failed to delete"))),
        { "rpc.aggregate": "workspace" },
      ),
  };
}

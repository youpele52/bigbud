import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import type { ProjectWriteFileDisposition } from "@bigbud/contracts/workspace/project.ts";

import {
  REMOTE_AGENT_DELETE_CAPABILITY,
  REMOTE_AGENT_MKDIR_CAPABILITY,
} from "../../remote-agent/remoteAgentProtocol.entryMutation.ts";
import { remoteAgentRequestDigest } from "../../remote-agent/remoteAgentRequestDigest.ts";
import {
  REMOTE_AGENT_ALREADY_EXISTS,
  REMOTE_AGENT_CREATE_ONLY_WRITE_CAPABILITY,
  RemoteAgentWorkspaceClient,
  RemoteAgentWorkspaceError,
} from "../../remote-agent/remoteAgentWorkspaceClient.ts";
import {
  createRemoteAgentDirectory,
  deleteRemoteAgentEntry,
} from "../../remote-agent/remoteAgentWorkspaceClient.entryMutation.ts";
import { WorkspaceFileSystemError } from "../../workspace/Services/WorkspaceFileSystem.ts";
import {
  readOnlyEntryActions,
  WORKSPACE_CREATE_DIRECTORY_OPERATION,
  WORKSPACE_DELETE_ENTRY_OPERATION,
  WORKSPACE_ENTRY_ALREADY_EXISTS,
  WORKSPACE_ENTRY_NOT_FOUND,
  type WorkspaceMutationsShape,
} from "../Services/WorkspaceMutations.ts";

const REMOTE_AGENT_NOT_FOUND = "NOT_FOUND";

interface RemoteMutationOptions {
  readonly resolve: (target: string) => Promise<RemoteAgentWorkspaceClient>;
  readonly remoteTarget: (target: string | undefined) => string;
  readonly open: (
    client: RemoteAgentWorkspaceClient,
    target: string,
    cwd: string,
  ) => Promise<string>;
}

function mutationError(
  value: { readonly cwd: string; readonly relativePath: string },
  operation: string,
  cause: unknown,
  dispatched: boolean,
): WorkspaceFileSystemError {
  const code = cause instanceof RemoteAgentWorkspaceError ? cause.code : undefined;
  const disposition: ProjectWriteFileDisposition = !dispatched
    ? "not-dispatched"
    : cause instanceof RemoteAgentWorkspaceError
      ? (cause.writeDisposition ?? "unknown")
      : "unknown";
  return new WorkspaceFileSystemError({
    cwd: value.cwd,
    relativePath: value.relativePath,
    operation,
    detail:
      code === REMOTE_AGENT_ALREADY_EXISTS
        ? WORKSPACE_ENTRY_ALREADY_EXISTS
        : code === REMOTE_AGENT_NOT_FOUND
          ? WORKSPACE_ENTRY_NOT_FOUND
          : cause instanceof Error
            ? cause.message
            : String(cause),
    retryable: false,
    writeDisposition: disposition,
    cause,
  });
}

/** Agent-backed create folder and delete. Agents without the capability are never sent a frame. */
export function makeRemoteWorkspaceMutations(
  options: RemoteMutationOptions,
): WorkspaceMutationsShape {
  const perform = <A>(
    value: {
      readonly executionTargetId?: string | undefined;
      readonly operationId?: string | undefined;
      readonly cwd: string;
      readonly relativePath: string;
    },
    operation: string,
    capability: string,
    send: (
      client: RemoteAgentWorkspaceClient,
      request: {
        readonly workspaceHandle: string;
        readonly path: string;
        readonly operationId: string;
        readonly requestDigest: Uint8Array;
      },
    ) => Promise<A>,
  ) => {
    let dispatched = false;
    return Effect.tryPromise({
      try: async () => {
        const target = options.remoteTarget(value.executionTargetId);
        const requestDigest = remoteAgentRequestDigest(value);
        const client = await options.resolve(target);
        if (!client.connection.supportsCapability(capability)) {
          throw new Error("This host's remote agent is too old for this action. Update the agent.");
        }
        const workspaceHandle = await options.open(client, target, value.cwd);
        dispatched = true;
        return send(client, {
          workspaceHandle,
          path: value.relativePath,
          operationId: value.operationId ?? `entry-${randomUUID()}`,
          requestDigest,
        });
      },
      catch: (cause) => mutationError(value, operation, cause, dispatched),
    });
  };

  return {
    entryActions: (value) =>
      Effect.promise(async () => {
        try {
          const client = await options.resolve(options.remoteTarget(value.executionTargetId));
          const has = (name: string) => client.connection.supportsCapability(name);
          return {
            createFile: has(REMOTE_AGENT_CREATE_ONLY_WRITE_CAPABILITY)
              ? { allowed: true }
              : { allowed: false, reason: "agentTooOld" as const },
            createFolder: has(REMOTE_AGENT_MKDIR_CAPABILITY)
              ? { allowed: true }
              : { allowed: false, reason: "agentTooOld" as const },
            // Remote deletes have no Trash: they are always permanent.
            delete: has(REMOTE_AGENT_DELETE_CAPABILITY)
              ? { allowed: true, permanent: true }
              : { allowed: false, reason: "agentTooOld" as const, permanent: true },
          };
        } catch {
          return readOnlyEntryActions("ownerUnavailable");
        }
      }),
    createDirectory: (value) =>
      perform(
        value,
        WORKSPACE_CREATE_DIRECTORY_OPERATION,
        REMOTE_AGENT_MKDIR_CAPABILITY,
        (client, request) => createRemoteAgentDirectory(client.connection, request),
      ).pipe(Effect.as({ relativePath: value.relativePath })),
    deleteEntry: (value) =>
      perform(
        value,
        WORKSPACE_DELETE_ENTRY_OPERATION,
        REMOTE_AGENT_DELETE_CAPABILITY,
        (client, request) =>
          deleteRemoteAgentEntry(client.connection, {
            ...request,
            expectedKind: value.expectedKind,
          }),
      ).pipe(Effect.as({ relativePath: value.relativePath, disposition: "deleted" as const })),
  };
}

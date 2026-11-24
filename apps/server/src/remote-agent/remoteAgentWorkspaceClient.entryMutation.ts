import { randomUUID } from "node:crypto";

import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type {
  RemoteAgentCreateDirectoryResponse,
  RemoteAgentDeleteEntryResponse,
} from "./remoteAgentProtocol.entryMutation.ts";
import { RemoteAgentWorkspaceError } from "./remoteAgentWorkspaceClient.ts";

interface EntryMutationInput {
  readonly workspaceHandle: string;
  readonly path: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly requestId?: string;
}

/** A lost connection or non-terminal answer may hide an applied change; it is never retried. */
function settle<T extends { readonly terminal: boolean; errorCode: string; errorMessage: string }>(
  response: T,
): T {
  if (!response.terminal || response.errorCode === "UNKNOWN_OUTCOME") {
    throw new RemoteAgentWorkspaceError(
      "UNKNOWN_OUTCOME",
      response.errorMessage || "The remote change did not report a final outcome.",
      "unknown",
    );
  }
  if (response.errorCode) {
    throw new RemoteAgentWorkspaceError(response.errorCode, response.errorMessage, "terminal");
  }
  return response;
}

async function requestOnce<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (cause) {
    throw new RemoteAgentWorkspaceError(
      "UNKNOWN_OUTCOME",
      `The remote host may have applied the change before the connection was lost; it was not retried. (${String(cause)})`,
      "unknown",
    );
  }
}

/** Creates one folder (`workspace.mkdir`); the parent must exist and an existing entry fails. */
export async function createRemoteAgentDirectory(
  connection: RemoteAgentConnection,
  input: EntryMutationInput,
): Promise<RemoteAgentCreateDirectoryResponse> {
  const requestId = input.requestId ?? randomUUID();
  const response = await requestOnce(
    async () =>
      (await connection.request(
        {
          type: "createDirectoryRequest",
          value: {
            requestId,
            operationId: input.operationId,
            requestDigest: input.requestDigest,
            workspaceHandle: input.workspaceHandle,
            path: input.path,
          },
        },
        (frame) => frame.type === "createDirectoryResponse" && frame.value.requestId === requestId,
      )) as {
        readonly type: "createDirectoryResponse";
        readonly value: RemoteAgentCreateDirectoryResponse;
      },
  );
  return settle(response.value);
}

/** Permanently deletes one entry (`workspace.delete`); a symlink is removed as a link. */
export async function deleteRemoteAgentEntry(
  connection: RemoteAgentConnection,
  input: EntryMutationInput & { readonly expectedKind: "file" | "directory" },
): Promise<RemoteAgentDeleteEntryResponse> {
  const requestId = input.requestId ?? randomUUID();
  const response = await requestOnce(
    async () =>
      (await connection.request(
        {
          type: "deleteEntryRequest",
          value: {
            requestId,
            operationId: input.operationId,
            requestDigest: input.requestDigest,
            workspaceHandle: input.workspaceHandle,
            path: input.path,
            expectedKind: input.expectedKind,
          },
        },
        (frame) => frame.type === "deleteEntryResponse" && frame.value.requestId === requestId,
      )) as {
        readonly type: "deleteEntryResponse";
        readonly value: RemoteAgentDeleteEntryResponse;
      },
  );
  return settle(response.value);
}

import {
  type RemoteAgentContentSearchResponse,
  type RemoteAgentDirectoryEntry,
  type RemoteAgentFilenameSearchResponse,
  type RemoteAgentListDirectoryResponse,
  type RemoteAgentReadFileResponse,
  type RemoteAgentWorkspaceOpenResponse,
  type RemoteAgentWriteFileResponse,
} from "./remoteAgentProtocol.ts";
import { RemoteAgentConnection, RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import {
  startRemoteAgentWorkspaceWatch,
  type RemoteAgentWorkspaceWatchSubscription,
} from "./remoteAgentWorkspaceWatchClient.ts";
import type { RemoteAgentWorkspaceWatchEvent } from "./remoteAgentProtocol.ts";
import type { RemoteAgentWorkspaceMutation } from "./remoteAgentWorkspaceMutation.ts";
import type { ProjectWriteFileDisposition } from "@bigbud/contracts/workspace/project.ts";

export class RemoteAgentWorkspaceError extends Error {
  readonly _tag = "RemoteAgentWorkspaceError";

  constructor(
    readonly code: string,
    message: string,
    readonly writeDisposition?: ProjectWriteFileDisposition,
  ) {
    super(message);
    this.name = "RemoteAgentWorkspaceError";
  }
}

function assertAccepted(response: {
  readonly errorCode: string;
  readonly errorMessage: string;
}): void {
  if (response.errorCode) {
    throw new RemoteAgentWorkspaceError(response.errorCode, response.errorMessage);
  }
}

function assertTerminalSuccess(response: {
  readonly terminal: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}): void {
  if (!response.terminal) throw new RemoteAgentConnectionError("Remote operation is not terminal.");
  assertAccepted(response);
}

export class RemoteAgentWorkspaceClient {
  constructor(
    readonly connection: RemoteAgentConnection,
    readonly reconnect?: () => Promise<RemoteAgentWorkspaceClient>,
    private readonly mutation?: RemoteAgentWorkspaceMutation,
  ) {}

  async openWorkspace(
    workspaceHandle: string,
    root: string,
    requestId = randomUUID(),
  ): Promise<RemoteAgentWorkspaceOpenResponse> {
    const response = (await this.connection.request(
      {
        type: "workspaceOpenRequest",
        value: { requestId, workspaceHandle, root },
      },
      (frame) => frame.type === "workspaceOpenResponse" && frame.value.requestId === requestId,
    )) as {
      readonly type: "workspaceOpenResponse";
      readonly value: RemoteAgentWorkspaceOpenResponse;
    };
    assertAccepted(response.value);
    return response.value;
  }

  async readFile(input: {
    readonly workspaceHandle: string;
    readonly path: string;
    readonly operationId: string;
    readonly requestDigest: Uint8Array;
    readonly offset?: number;
    readonly maxBytes?: number;
    readonly requestId?: string;
  }): Promise<RemoteAgentReadFileResponse> {
    const requestId = input.requestId ?? randomUUID();
    const response = (await this.connection.request(
      {
        type: "readFileRequest",
        value: {
          requestId,
          operationId: input.operationId,
          requestDigest: input.requestDigest,
          workspaceHandle: input.workspaceHandle,
          path: input.path,
          offset: input.offset ?? 0,
          maxBytes: input.maxBytes ?? 5 * 1024 * 1024,
        },
      },
      (frame) => frame.type === "readFileResponse" && frame.value.requestId === requestId,
    )) as { readonly type: "readFileResponse"; readonly value: RemoteAgentReadFileResponse };
    assertTerminalSuccess(response.value);
    return response.value;
  }

  async listDirectory(input: {
    readonly workspaceHandle: string;
    readonly path: string;
    readonly operationId: string;
    readonly requestDigest: Uint8Array;
    readonly requestId?: string;
  }): Promise<ReadonlyArray<RemoteAgentDirectoryEntry>> {
    const requestId = input.requestId ?? randomUUID();
    const response = (await this.connection.request(
      {
        type: "listDirectoryRequest",
        value: {
          requestId,
          operationId: input.operationId,
          requestDigest: input.requestDigest,
          workspaceHandle: input.workspaceHandle,
          path: input.path,
        },
      },
      (frame) => frame.type === "listDirectoryResponse" && frame.value.requestId === requestId,
    )) as {
      readonly type: "listDirectoryResponse";
      readonly value: RemoteAgentListDirectoryResponse;
    };
    assertTerminalSuccess(response.value);
    return response.value.entries;
  }

  watchDirectory(input: {
    readonly subscriptionId: string;
    readonly workspaceHandle: string;
    readonly path: string;
    readonly onEvent: (event: RemoteAgentWorkspaceWatchEvent) => void;
    readonly requestId?: string;
  }): Promise<RemoteAgentWorkspaceWatchSubscription> {
    return startRemoteAgentWorkspaceWatch({ connection: this.connection, ...input });
  }

  async writeFile(
    input: {
      readonly workspaceHandle: string;
      readonly path: string;
      readonly operationId: string;
      readonly requestDigest: Uint8Array;
      readonly bytes: Uint8Array;
      readonly expectedSha256?: string;
      readonly requestId?: string;
    },
    beforeRequest?: () => Promise<() => void>,
  ): Promise<RemoteAgentWriteFileResponse> {
    const requestId = input.requestId ?? randomUUID();
    await this.mutation?.prepare(input.operationId, input.requestDigest);
    try {
      if (beforeRequest) {
        const validate = await beforeRequest();
        validate();
      }
    } catch (cause) {
      // The final guard ran before any native request; this reservation is definitively undispatched.
      let message = cause instanceof Error ? cause.message : String(cause);
      try {
        await this.mutation?.terminal(input.operationId);
      } catch (cleanupCause) {
        message += `; owner cleanup failed: ${String(cleanupCause)}`;
      }
      throw new RemoteAgentWorkspaceError("WRITE_NOT_DISPATCHED", message, "not-dispatched");
    }
    let response: {
      readonly type: "writeFileResponse";
      readonly value: RemoteAgentWriteFileResponse;
    };
    try {
      response = (await this.connection.request(
        {
          type: "writeFileRequest",
          value: { ...input, requestId, expectedSha256: input.expectedSha256 ?? "" },
        },
        (frame) => frame.type === "writeFileResponse" && frame.value.requestId === requestId,
      )) as { readonly type: "writeFileResponse"; readonly value: RemoteAgentWriteFileResponse };
    } catch (cause) {
      let message =
        "The remote file write may have been accepted before the connection was lost; it was not retried.";
      try {
        await this.mutation?.unknown(input.operationId);
      } catch (cleanupCause) {
        message += `; owner update failed: ${String(cleanupCause)}`;
      }
      throw new RemoteAgentWorkspaceError(
        "UNKNOWN_OUTCOME",
        `${message} (${String(cause)})`,
        "unknown",
      );
    }
    if (!response.value.terminal || response.value.errorCode === "UNKNOWN_OUTCOME") {
      let message = response.value.errorMessage || "Remote write outcome is not terminal.";
      try {
        await this.mutation?.unknown(input.operationId);
      } catch (cause) {
        message += `; owner update failed: ${String(cause)}`;
      }
      throw new RemoteAgentWorkspaceError("UNKNOWN_OUTCOME", message, "unknown");
    }
    try {
      await this.mutation?.terminal(input.operationId);
    } catch (cause) {
      throw new RemoteAgentWorkspaceError(
        "WRITE_FINALIZATION_FAILED",
        `${response.value.errorMessage || "Remote file write completed"}; owner cleanup failed: ${String(cause)}`,
        "terminal",
      );
    }
    if (response.value.errorCode) {
      throw new RemoteAgentWorkspaceError(
        response.value.errorCode,
        response.value.errorMessage,
        "terminal",
      );
    }
    return response.value;
  }

  async searchFilenames(input: {
    readonly workspaceHandle: string;
    readonly path: string;
    readonly query: string;
    readonly maxResults: number;
    readonly operationId: string;
    readonly requestDigest: Uint8Array;
    readonly requestId?: string;
  }): Promise<ReadonlyArray<RemoteAgentDirectoryEntry>> {
    const requestId = input.requestId ?? randomUUID();
    const response = (await this.connection.request(
      {
        type: "filenameSearchRequest",
        value: { ...input, requestId },
      },
      (frame) => frame.type === "filenameSearchResponse" && frame.value.requestId === requestId,
    )) as {
      readonly type: "filenameSearchResponse";
      readonly value: RemoteAgentFilenameSearchResponse;
    };
    assertTerminalSuccess(response.value);
    return response.value.entries;
  }

  async searchContent(input: {
    readonly workspaceHandle: string;
    readonly path: string;
    readonly query: string;
    readonly maxResults: number;
    readonly operationId: string;
    readonly requestDigest: Uint8Array;
    readonly requestId?: string;
  }): Promise<RemoteAgentContentSearchResponse> {
    const requestId = input.requestId ?? randomUUID();
    const response = (await this.connection.request(
      {
        type: "contentSearchRequest",
        value: { ...input, requestId },
      },
      (frame) => frame.type === "contentSearchResponse" && frame.value.requestId === requestId,
    )) as {
      readonly type: "contentSearchResponse";
      readonly value: RemoteAgentContentSearchResponse;
    };
    assertTerminalSuccess(response.value);
    return response.value;
  }
}
import { randomUUID } from "node:crypto";

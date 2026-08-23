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

export class RemoteAgentWorkspaceError extends Error {
  readonly _tag = "RemoteAgentWorkspaceError";

  constructor(
    readonly code: string,
    message: string,
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
  constructor(readonly connection: RemoteAgentConnection) {}

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

  async writeFile(input: {
    readonly workspaceHandle: string;
    readonly path: string;
    readonly operationId: string;
    readonly requestDigest: Uint8Array;
    readonly bytes: Uint8Array;
    readonly expectedSha256?: string;
    readonly requestId?: string;
  }): Promise<RemoteAgentWriteFileResponse> {
    const requestId = input.requestId ?? randomUUID();
    try {
      const response = (await this.connection.request(
        {
          type: "writeFileRequest",
          value: { ...input, requestId, expectedSha256: input.expectedSha256 ?? "" },
        },
        (frame) => frame.type === "writeFileResponse" && frame.value.requestId === requestId,
      )) as { readonly type: "writeFileResponse"; readonly value: RemoteAgentWriteFileResponse };
      assertTerminalSuccess(response.value);
      return response.value;
    } catch (cause) {
      if (cause instanceof RemoteAgentConnectionError) {
        throw new RemoteAgentWorkspaceError(
          "UNKNOWN_OUTCOME",
          "The remote file write may have been accepted before the connection was lost; it was not retried.",
        );
      }
      throw cause;
    }
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

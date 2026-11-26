/**
 * Files create-folder and delete frames (`workspace.proto`, frames 110-113). Create folder needs
 * capability `workspace.mkdir` 1.0; delete needs `workspace.delete` 1.0. Older agents never
 * receive these frames.
 */
export const REMOTE_AGENT_MKDIR_CAPABILITY = "workspace.mkdir";
export const REMOTE_AGENT_DELETE_CAPABILITY = "workspace.delete";

export interface RemoteAgentCreateDirectoryRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly workspaceHandle: string;
  readonly path: string;
}

export interface RemoteAgentCreateDirectoryResponse {
  readonly requestId: string;
  readonly operationId: string;
  readonly terminal: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentDeleteEntryRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly workspaceHandle: string;
  readonly path: string;
  /** `file` or `directory`: the kind the user confirmed. A symlink is always removed as a link. */
  readonly expectedKind: string;
}

export interface RemoteAgentDeleteEntryResponse {
  readonly requestId: string;
  readonly operationId: string;
  readonly terminal: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
  /** `file`, `directory` or `symlink` on success. */
  readonly deletedKind: string;
}

export type RemoteAgentEntryMutationFrame =
  | {
      readonly type: "createDirectoryRequest";
      readonly value: RemoteAgentCreateDirectoryRequest;
    }
  | {
      readonly type: "createDirectoryResponse";
      readonly value: RemoteAgentCreateDirectoryResponse;
    }
  | { readonly type: "deleteEntryRequest"; readonly value: RemoteAgentDeleteEntryRequest }
  | { readonly type: "deleteEntryResponse"; readonly value: RemoteAgentDeleteEntryResponse };

export type RemoteAgentResourceCleanupEntryType = "file" | "directory";
export type RemoteAgentResourceCleanupOutcome =
  | "removed"
  | "already_absent"
  | "resumed_and_removed"
  | "identity_mismatch"
  | "unsupported_entry"
  | "busy"
  | "permission_denied"
  | "deadline_exceeded"
  | "io_failure"
  | "process_failure"
  | "protocol_failure";

export interface RemoteAgentResourceCleanupIdentity {
  readonly deviceOrVolume: string;
  readonly inodeOrFileId: string;
  readonly entryType: RemoteAgentResourceCleanupEntryType;
}

export interface RemoteAgentResourceCleanupRoot {
  readonly rootId: string;
  readonly path: string;
  readonly identity: RemoteAgentResourceCleanupIdentity;
}

export interface RemoteAgentResourceCleanupRootBootstrapRequest {
  readonly requestId: string;
  readonly platform: string;
  readonly roots: ReadonlyArray<RemoteAgentResourceCleanupRoot>;
}

export interface RemoteAgentResourceCleanupRootBootstrapResponse {
  readonly requestId: string;
  readonly accepted: boolean;
  readonly errorCode: string;
  readonly roots: ReadonlyArray<{ readonly rootId: string; readonly rootHandle: string }>;
}

export interface RemoteAgentResourceCleanupResource {
  readonly resourceId: string;
  readonly rootHandle: string;
  readonly relativePath: string;
  readonly quarantineName: string;
  readonly identity?: RemoteAgentResourceCleanupIdentity;
  readonly rootIdentity: RemoteAgentResourceCleanupIdentity;
  readonly parentIdentity: RemoteAgentResourceCleanupIdentity;
  readonly action: "delete";
}

export interface RemoteAgentResourceCleanupRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly pageDigest: Uint8Array;
  readonly deadlineUnixMs: number;
  readonly platform: string;
  readonly resources: ReadonlyArray<RemoteAgentResourceCleanupResource>;
  readonly planDigest: Uint8Array;
  readonly finalizeProofDigest: Uint8Array;
  readonly authorizationDigest: Uint8Array;
}

export interface RemoteAgentResourceCleanupResponse {
  readonly requestId: string;
  readonly operationId: string;
  readonly results: ReadonlyArray<{
    readonly resourceId: string;
    readonly outcome: RemoteAgentResourceCleanupOutcome;
    readonly errorCode: string;
  }>;
}

export type RemoteAgentResourceCleanupFrame =
  | {
      readonly type: "resourceCleanupRootBootstrapRequest";
      readonly value: RemoteAgentResourceCleanupRootBootstrapRequest;
    }
  | {
      readonly type: "resourceCleanupRootBootstrapResponse";
      readonly value: RemoteAgentResourceCleanupRootBootstrapResponse;
    }
  | { readonly type: "resourceCleanupRequest"; readonly value: RemoteAgentResourceCleanupRequest }
  | {
      readonly type: "resourceCleanupResponse";
      readonly value: RemoteAgentResourceCleanupResponse;
    }
  | {
      readonly type: "resourceCleanupKeepAliveRequest";
      readonly value: { readonly requestId: string };
    }
  | {
      readonly type: "resourceCleanupKeepAliveResponse";
      readonly value: { readonly requestId: string };
    }
  | {
      readonly type: "resourceCleanupCancelRequest";
      readonly value: { readonly requestId: string; readonly operationId: string };
    }
  | {
      readonly type: "resourceCleanupCancelResponse";
      readonly value: {
        readonly requestId: string;
        readonly operationId: string;
        readonly cancellationRequested: boolean;
        readonly terminal: boolean;
      };
    };

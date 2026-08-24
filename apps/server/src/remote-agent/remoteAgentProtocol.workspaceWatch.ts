export interface RemoteAgentWorkspaceWatchStartRequest {
  readonly requestId: string;
  readonly subscriptionId: string;
  readonly workspaceHandle: string;
  readonly path: string;
}

export interface RemoteAgentWorkspaceWatchStartResponse {
  readonly requestId: string;
  readonly subscriptionId: string;
  readonly accepted: boolean;
  readonly generation: number;
  readonly backend: string;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export type RemoteAgentWorkspaceChangeKind = "create" | "modify" | "remove" | "unknown";

export interface RemoteAgentWorkspaceChange {
  readonly path: string;
  readonly kind: RemoteAgentWorkspaceChangeKind;
}

export interface RemoteAgentWorkspaceWatchEvent {
  readonly subscriptionId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly changes: ReadonlyArray<RemoteAgentWorkspaceChange>;
  readonly rescanRequired: boolean;
  readonly rescanReason: string;
  readonly backend: string;
}

export interface RemoteAgentWorkspaceWatchStopRequest {
  readonly requestId: string;
  readonly subscriptionId: string;
}

export interface RemoteAgentWorkspaceWatchStopResponse {
  readonly requestId: string;
  readonly subscriptionId: string;
  readonly stopped: boolean;
}

export type RemoteAgentWorkspaceWatchFrame =
  | {
      readonly type: "workspaceWatchStartRequest";
      readonly value: RemoteAgentWorkspaceWatchStartRequest;
    }
  | {
      readonly type: "workspaceWatchStartResponse";
      readonly value: RemoteAgentWorkspaceWatchStartResponse;
    }
  | { readonly type: "workspaceWatchEvent"; readonly value: RemoteAgentWorkspaceWatchEvent }
  | {
      readonly type: "workspaceWatchStopRequest";
      readonly value: RemoteAgentWorkspaceWatchStopRequest;
    }
  | {
      readonly type: "workspaceWatchStopResponse";
      readonly value: RemoteAgentWorkspaceWatchStopResponse;
    };

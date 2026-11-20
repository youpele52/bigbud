import type { RemoteAgentProcessEnvironment } from "./remoteAgentProtocol.ts";

export interface RemoteAgentPtyCreateRequest {
  readonly requestId: string;
  readonly ptyId: string;
  readonly requestDigest: Uint8Array;
  readonly workspaceHandle: string;
  readonly cwd: string;
  readonly shell: string;
  /** Requires terminal.shell-profiles v1. Absent/false retains legacy command semantics. */
  readonly profileLaunch?: boolean;
  readonly args: ReadonlyArray<string>;
  readonly cols: number;
  readonly rows: number;
  readonly environment?: ReadonlyArray<RemoteAgentProcessEnvironment>;
}

export interface RemoteAgentPtyCreateResponse {
  readonly requestId: string;
  readonly ptyId: string;
  readonly accepted: boolean;
  readonly pid: number;
  /** Absent means unknown; a PID or running state is not launch confirmation. */
  readonly launchStatus?: "unconfirmed";
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentPtyInput {
  readonly requestId: string;
  readonly ptyId: string;
  readonly sequence: number;
  readonly bytes: Uint8Array;
}

export interface RemoteAgentPtyOutput {
  readonly ptyId: string;
  readonly sequence: number;
  readonly bytes: Uint8Array;
}

export interface RemoteAgentPtyOutputAck {
  readonly requestId: string;
  readonly ptyId: string;
  readonly acknowledgedSequence: number;
}

export interface RemoteAgentPtyResizeRequest {
  readonly requestId: string;
  readonly ptyId: string;
  readonly cols: number;
  readonly rows: number;
}

export interface RemoteAgentPtyResizeResponse {
  readonly requestId: string;
  readonly ptyId: string;
  readonly accepted: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentPtySignalRequest {
  readonly requestId: string;
  readonly ptyId: string;
  readonly signal: string;
}

export interface RemoteAgentPtySignalResponse {
  readonly requestId: string;
  readonly ptyId: string;
  readonly accepted: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentPtyAttachRequest {
  readonly requestId: string;
  readonly ptyId: string;
  readonly afterSequence: number;
}

export interface RemoteAgentPtyAttachResponse {
  readonly requestId: string;
  readonly ptyId: string;
  readonly state: string;
  readonly pid: number;
  /** Absent means unknown; a PID or running state is not launch confirmation. */
  readonly launchStatus?: "unconfirmed";
  readonly nextSequence: number;
  readonly firstRetainedSequence: number;
  readonly replayGap: boolean;
}

export interface RemoteAgentPtyCloseRequest {
  readonly requestId: string;
  readonly ptyId: string;
  readonly terminate: boolean;
}

export interface RemoteAgentPtyCloseResponse {
  readonly requestId: string;
  readonly ptyId: string;
  readonly accepted: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentPtyExited {
  readonly ptyId: string;
  readonly exitCode: number;
  readonly hasExitCode: boolean;
  readonly signal: number;
  readonly hasSignal: boolean;
}

export interface RemoteAgentPtyControlResponse {
  readonly requestId: string;
  readonly ptyId: string;
  readonly accepted: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentPtyListRequest {
  readonly requestId: string;
  readonly expectedEpoch: string;
  readonly afterPtyId: string;
  readonly limit: number;
  readonly snapshotId: string;
}

export interface RemoteAgentPtyInventoryEntry {
  readonly ptyId: string;
  readonly requestDigest: Uint8Array;
  readonly state: string;
  readonly pid: number;
  readonly nextSequence: number;
  readonly firstRetainedSequence: number;
  readonly verifiedExit: boolean;
  readonly launchStatus: string;
}

export interface RemoteAgentPtyListResponse {
  readonly requestId: string;
  readonly agentEpoch: string;
  readonly entries: ReadonlyArray<RemoteAgentPtyInventoryEntry>;
  readonly nextAfterPtyId: string;
  readonly snapshotId: string;
  readonly accepted: boolean;
  readonly errorCode: string;
}

export interface RemoteAgentPtyDetachRequest {
  readonly requestId: string;
  readonly ptyId: string;
}

export interface RemoteAgentPtyInputReconcileRequest {
  readonly requestId: string;
  readonly expectedEpoch: string;
  readonly ptyId: string;
  readonly createDigest: Uint8Array;
  readonly sequence: number;
  readonly payloadDigest: Uint8Array;
  readonly byteLength: number;
}

export interface RemoteAgentPtyInputReconcileResponse {
  readonly requestId: string;
  readonly agentEpoch: string;
  readonly ptyId: string;
  readonly createDigest: Uint8Array;
  readonly sequence: number;
  readonly payloadDigest: Uint8Array;
  readonly byteLength: number;
  readonly outcome: string;
  readonly bytesWritten: number;
  readonly writerUsable: boolean;
  readonly accepted: boolean;
  readonly errorCode: string;
}

export type RemoteAgentPtyFrame =
  | {
      readonly type: "ptyInputReconcileRequest";
      readonly value: RemoteAgentPtyInputReconcileRequest;
    }
  | {
      readonly type: "ptyInputReconcileResponse";
      readonly value: RemoteAgentPtyInputReconcileResponse;
    }
  | { readonly type: "ptyDetachRequest"; readonly value: RemoteAgentPtyDetachRequest }
  | { readonly type: "ptyDetachResponse"; readonly value: RemoteAgentPtyControlResponse }
  | { readonly type: "ptyListRequest"; readonly value: RemoteAgentPtyListRequest }
  | { readonly type: "ptyListResponse"; readonly value: RemoteAgentPtyListResponse }
  | { readonly type: "ptyCreateRequest"; readonly value: RemoteAgentPtyCreateRequest }
  | { readonly type: "ptyCreateResponse"; readonly value: RemoteAgentPtyCreateResponse }
  | { readonly type: "ptyInput"; readonly value: RemoteAgentPtyInput }
  | { readonly type: "ptyOutput"; readonly value: RemoteAgentPtyOutput }
  | { readonly type: "ptyOutputAck"; readonly value: RemoteAgentPtyOutputAck }
  | { readonly type: "ptyResizeRequest"; readonly value: RemoteAgentPtyResizeRequest }
  | { readonly type: "ptyResizeResponse"; readonly value: RemoteAgentPtyResizeResponse }
  | { readonly type: "ptySignalRequest"; readonly value: RemoteAgentPtySignalRequest }
  | { readonly type: "ptySignalResponse"; readonly value: RemoteAgentPtySignalResponse }
  | { readonly type: "ptyAttachRequest"; readonly value: RemoteAgentPtyAttachRequest }
  | { readonly type: "ptyAttachResponse"; readonly value: RemoteAgentPtyAttachResponse }
  | { readonly type: "ptyCloseRequest"; readonly value: RemoteAgentPtyCloseRequest }
  | { readonly type: "ptyCloseResponse"; readonly value: RemoteAgentPtyCloseResponse }
  | { readonly type: "ptyExited"; readonly value: RemoteAgentPtyExited }
  | { readonly type: "ptyInputResponse"; readonly value: RemoteAgentPtyControlResponse }
  | { readonly type: "ptyOutputAckResponse"; readonly value: RemoteAgentPtyControlResponse };

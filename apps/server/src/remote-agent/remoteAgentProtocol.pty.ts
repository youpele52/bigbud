import type { RemoteAgentProcessEnvironment } from "./remoteAgentProtocol.ts";

export interface RemoteAgentPtyCreateRequest {
  readonly requestId: string;
  readonly ptyId: string;
  readonly requestDigest: Uint8Array;
  readonly workspaceHandle: string;
  readonly cwd: string;
  readonly shell: string;
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

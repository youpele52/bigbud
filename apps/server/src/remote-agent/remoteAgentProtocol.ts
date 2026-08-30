import type {
  RemoteAgentPtyAttachRequest,
  RemoteAgentPtyAttachResponse,
  RemoteAgentPtyCloseRequest,
  RemoteAgentPtyCloseResponse,
  RemoteAgentPtyControlResponse,
  RemoteAgentPtyCreateRequest,
  RemoteAgentPtyCreateResponse,
  RemoteAgentPtyExited,
  RemoteAgentPtyInput,
  RemoteAgentPtyOutput,
  RemoteAgentPtyOutputAck,
  RemoteAgentPtyResizeRequest,
  RemoteAgentPtyResizeResponse,
  RemoteAgentPtySignalRequest,
  RemoteAgentPtySignalResponse,
} from "./remoteAgentProtocol.pty.ts";
import type { RemoteAgentWorkspaceWatchFrame } from "./remoteAgentProtocol.workspaceWatch.ts";
import type { RemoteAgentResourceCleanupFrame } from "./remoteAgentProtocol.resourceCleanup.ts";

export const REMOTE_AGENT_PROTOCOL_MAJOR = 1;
export const REMOTE_AGENT_PROTOCOL_MINOR = 2;
export const REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

export interface RemoteAgentClientHello {
  readonly protocolMajor: number;
  readonly protocolMinor: number;
  readonly clientInstanceId: string;
  readonly connectionId: string;
  readonly serverNonce: string;
  readonly maxFrameBytes: number;
}

export interface RemoteAgentCapability {
  readonly name: string;
  readonly major: number;
  readonly minor: number;
}

export interface RemoteAgentHello {
  readonly protocolMajor: number;
  readonly protocolMinor: number;
  readonly agentVersion: string;
  readonly buildDigest: string;
  readonly os: string;
  readonly architecture: string;
  readonly agentInstanceId: string;
  readonly agentEpoch: string;
  readonly capabilities: ReadonlyArray<RemoteAgentCapability>;
  readonly maxFrameBytes: number;
  readonly maxOperationOutputBytes: number;
  readonly maxJournalBytes: number;
}

export interface RemoteAgentDiagnosticRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly workspaceHandle: string;
  readonly deadlineUnixMs: number;
  readonly kind: string;
}

export interface RemoteAgentDiagnosticResponse {
  readonly requestId: string;
  readonly operationId: string;
  readonly accepted: boolean;
  readonly terminal: boolean;
  readonly message: string;
}

export interface RemoteAgentCancelRequest {
  readonly requestId: string;
  readonly operationId: string;
}

export interface RemoteAgentCancelResponse {
  readonly requestId: string;
  readonly operationId: string;
  readonly cancelled: boolean;
  readonly terminal: boolean;
  readonly detail: string;
}

export interface RemoteAgentProtocolError {
  readonly requestId: string;
  readonly code: string;
  readonly message: string;
}

export interface RemoteAgentWorkspaceOpenRequest {
  readonly requestId: string;
  readonly workspaceHandle: string;
  readonly root: string;
}

export interface RemoteAgentWorkspaceOpenResponse {
  readonly requestId: string;
  readonly workspaceHandle: string;
  readonly accepted: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentReadFileRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly workspaceHandle: string;
  readonly path: string;
  readonly offset: number;
  readonly maxBytes: number;
}

export interface RemoteAgentReadFileResponse {
  readonly requestId: string;
  readonly operationId: string;
  readonly terminal: boolean;
  readonly bytes: Uint8Array;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentDirectoryEntry {
  readonly path: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly sizeBytes: number;
  readonly modifiedUnixMs?: number;
}

export interface RemoteAgentListDirectoryRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly workspaceHandle: string;
  readonly path: string;
}

export interface RemoteAgentListDirectoryResponse {
  readonly requestId: string;
  readonly operationId: string;
  readonly terminal: boolean;
  readonly entries: ReadonlyArray<RemoteAgentDirectoryEntry>;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentFilenameSearchRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly workspaceHandle: string;
  readonly path: string;
  readonly query: string;
  readonly maxResults: number;
}

export interface RemoteAgentFilenameSearchResponse {
  readonly requestId: string;
  readonly operationId: string;
  readonly terminal: boolean;
  readonly entries: ReadonlyArray<RemoteAgentDirectoryEntry>;
  readonly truncated: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentContentMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly excerpt: string;
}

export interface RemoteAgentContentSearchRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly workspaceHandle: string;
  readonly path: string;
  readonly query: string;
  readonly maxResults: number;
}

export interface RemoteAgentContentSearchResponse {
  readonly requestId: string;
  readonly operationId: string;
  readonly terminal: boolean;
  readonly matches: ReadonlyArray<RemoteAgentContentMatch>;
  readonly truncated: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentWriteFileRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly workspaceHandle: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly expectedSha256: string;
}

export interface RemoteAgentWriteFileResponse {
  readonly requestId: string;
  readonly operationId: string;
  readonly terminal: boolean;
  readonly writtenBytes: number;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly currentSha256: string;
}

export interface RemoteAgentProcessRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly workspaceHandle: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly environment?: ReadonlyArray<RemoteAgentProcessEnvironment>;
  readonly stdin?: Uint8Array;
}

export interface RemoteAgentProcessEnvironment {
  readonly name: string;
  readonly value: string;
}

export interface RemoteAgentProcessAccepted {
  readonly requestId: string;
  readonly operationId: string;
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentProcessOutput {
  readonly operationId: string;
  readonly sequence: number;
  readonly stream: "stdout" | "stderr";
  readonly bytes: Uint8Array;
}

export interface RemoteAgentProcessCompleted {
  readonly requestId: string;
  readonly operationId: string;
  readonly state: string;
  readonly hasExitCode: boolean;
  readonly exitCode: number;
  readonly outputTruncated: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentProcessAttachRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly afterSequence: number;
}

export interface RemoteAgentProcessOutputAck {
  readonly requestId: string;
  readonly operationId: string;
  readonly acknowledgedSequence: number;
}

export interface RemoteAgentProcessAckResponse {
  readonly requestId: string;
  readonly operationId: string;
  readonly accepted: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentProcessAttachResponse {
  readonly requestId: string;
  readonly operationId: string;
  readonly state: string;
  readonly nextSequence: number;
  readonly firstRetainedSequence: number;
}

export type {
  RemoteAgentPtyAttachRequest,
  RemoteAgentPtyAttachResponse,
  RemoteAgentPtyCloseRequest,
  RemoteAgentPtyCloseResponse,
  RemoteAgentPtyControlResponse,
  RemoteAgentPtyCreateRequest,
  RemoteAgentPtyCreateResponse,
  RemoteAgentPtyExited,
  RemoteAgentPtyInput,
  RemoteAgentPtyOutput,
  RemoteAgentPtyOutputAck,
  RemoteAgentPtyResizeRequest,
  RemoteAgentPtyResizeResponse,
  RemoteAgentPtySignalRequest,
  RemoteAgentPtySignalResponse,
} from "./remoteAgentProtocol.pty.ts";
export type {
  RemoteAgentWorkspaceChange,
  RemoteAgentWorkspaceChangeKind,
  RemoteAgentWorkspaceWatchEvent,
  RemoteAgentWorkspaceWatchStartRequest,
  RemoteAgentWorkspaceWatchStartResponse,
  RemoteAgentWorkspaceWatchStopRequest,
  RemoteAgentWorkspaceWatchStopResponse,
} from "./remoteAgentProtocol.workspaceWatch.ts";

export type RemoteAgentFrame =
  | RemoteAgentResourceCleanupFrame
  | RemoteAgentWorkspaceWatchFrame
  | { readonly type: "clientHello"; readonly value: RemoteAgentClientHello }
  | { readonly type: "agentHello"; readonly value: RemoteAgentHello }
  | { readonly type: "diagnosticRequest"; readonly value: RemoteAgentDiagnosticRequest }
  | { readonly type: "diagnosticResponse"; readonly value: RemoteAgentDiagnosticResponse }
  | { readonly type: "cancelRequest"; readonly value: RemoteAgentCancelRequest }
  | { readonly type: "cancelResponse"; readonly value: RemoteAgentCancelResponse }
  | { readonly type: "protocolError"; readonly value: RemoteAgentProtocolError }
  | {
      readonly type: "workspaceOpenRequest";
      readonly value: RemoteAgentWorkspaceOpenRequest;
    }
  | {
      readonly type: "workspaceOpenResponse";
      readonly value: RemoteAgentWorkspaceOpenResponse;
    }
  | { readonly type: "readFileRequest"; readonly value: RemoteAgentReadFileRequest }
  | { readonly type: "readFileResponse"; readonly value: RemoteAgentReadFileResponse }
  | {
      readonly type: "listDirectoryRequest";
      readonly value: RemoteAgentListDirectoryRequest;
    }
  | {
      readonly type: "listDirectoryResponse";
      readonly value: RemoteAgentListDirectoryResponse;
    }
  | {
      readonly type: "filenameSearchRequest";
      readonly value: RemoteAgentFilenameSearchRequest;
    }
  | {
      readonly type: "filenameSearchResponse";
      readonly value: RemoteAgentFilenameSearchResponse;
    }
  | {
      readonly type: "contentSearchRequest";
      readonly value: RemoteAgentContentSearchRequest;
    }
  | {
      readonly type: "contentSearchResponse";
      readonly value: RemoteAgentContentSearchResponse;
    }
  | { readonly type: "writeFileRequest"; readonly value: RemoteAgentWriteFileRequest }
  | { readonly type: "writeFileResponse"; readonly value: RemoteAgentWriteFileResponse }
  | { readonly type: "processRequest"; readonly value: RemoteAgentProcessRequest }
  | { readonly type: "processAccepted"; readonly value: RemoteAgentProcessAccepted }
  | { readonly type: "processOutput"; readonly value: RemoteAgentProcessOutput }
  | { readonly type: "processCompleted"; readonly value: RemoteAgentProcessCompleted }
  | { readonly type: "processAttachRequest"; readonly value: RemoteAgentProcessAttachRequest }
  | { readonly type: "processOutputAck"; readonly value: RemoteAgentProcessOutputAck }
  | { readonly type: "processAckResponse"; readonly value: RemoteAgentProcessAckResponse }
  | { readonly type: "processAttachResponse"; readonly value: RemoteAgentProcessAttachResponse }
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

export class RemoteAgentProtocolDecodeError extends Error {
  readonly _tag = "RemoteAgentProtocolDecodeError";

  constructor(message: string) {
    super(message);
    this.name = "RemoteAgentProtocolDecodeError";
  }
}

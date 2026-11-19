/** Terminal paste staging frames (`paste_staging.proto`, capability `terminal.paste-staging`). */
export const REMOTE_AGENT_PASTE_STAGING_CAPABILITY = "terminal.paste-staging";

export interface RemoteAgentPasteStageBeginRequest {
  readonly requestId: string;
  readonly scope: string;
  readonly uploadId: string;
  readonly totalBytes: number;
  readonly extension: string;
  readonly imageMimeType: string;
}

export interface RemoteAgentPasteStageBeginResponse {
  readonly requestId: string;
  readonly uploadId: string;
  readonly accepted: boolean;
  readonly maxChunkBytes: number;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentPasteStageChunkRequest {
  readonly requestId: string;
  readonly uploadId: string;
  readonly offset: number;
  readonly data: Uint8Array;
}

export interface RemoteAgentPasteStageChunkResponse {
  readonly requestId: string;
  readonly uploadId: string;
  readonly receivedBytes: number;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentPasteStageCommitRequest {
  readonly requestId: string;
  readonly uploadId: string;
  readonly sha256: Uint8Array;
}

export interface RemoteAgentPasteStageCommitResponse {
  readonly requestId: string;
  readonly uploadId: string;
  readonly path: string;
  readonly clipboard: string;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentPasteStageDiscardRequest {
  readonly requestId: string;
  readonly scope: string;
  readonly uploadId: string;
}

export interface RemoteAgentPasteStageDiscardResponse {
  readonly requestId: string;
  readonly removed: number;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export type RemoteAgentPasteStagingFrame =
  | { readonly type: "pasteStageBeginRequest"; readonly value: RemoteAgentPasteStageBeginRequest }
  | { readonly type: "pasteStageBeginResponse"; readonly value: RemoteAgentPasteStageBeginResponse }
  | { readonly type: "pasteStageChunkRequest"; readonly value: RemoteAgentPasteStageChunkRequest }
  | { readonly type: "pasteStageChunkResponse"; readonly value: RemoteAgentPasteStageChunkResponse }
  | { readonly type: "pasteStageCommitRequest"; readonly value: RemoteAgentPasteStageCommitRequest }
  | {
      readonly type: "pasteStageCommitResponse";
      readonly value: RemoteAgentPasteStageCommitResponse;
    }
  | {
      readonly type: "pasteStageDiscardRequest";
      readonly value: RemoteAgentPasteStageDiscardRequest;
    }
  | {
      readonly type: "pasteStageDiscardResponse";
      readonly value: RemoteAgentPasteStageDiscardResponse;
    };

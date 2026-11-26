/** Write receipt frames (`workspace.proto`, frames 108-109, capability `workspace.write` 1.2). */
export const REMOTE_AGENT_WRITE_CAPABILITY = "workspace.write";
/** `workspace.write` minor that adds the write receipt query. */
export const REMOTE_AGENT_WRITE_RECEIPT_MINOR = 2;

export interface RemoteAgentWriteReceiptRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
}

export interface RemoteAgentWriteReceiptResponse {
  readonly requestId: string;
  readonly operationId: string;
  /** True only when the agent recorded a successful write for this exact identity. */
  readonly applied: boolean;
  /** Lowercase hex SHA-256 of the written bytes; set when applied. */
  readonly resultSha256: string;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export type RemoteAgentWriteReceiptFrame =
  | { readonly type: "writeReceiptRequest"; readonly value: RemoteAgentWriteReceiptRequest }
  | { readonly type: "writeReceiptResponse"; readonly value: RemoteAgentWriteReceiptResponse };

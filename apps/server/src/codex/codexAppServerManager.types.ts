import { type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import {
  ApprovalRequestId,
  ProviderItemId,
  ProviderInteractionMode,
  ProviderRequestKind,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";

import { type CodexAccountSnapshot } from "../provider/codexAccount";

export type PendingRequestKey = string;

export interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface PendingApprovalRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/fileRead/requestApproval";
  requestKind: ProviderRequestKind;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

export interface PendingUserInputRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

export interface CodexUserInputAnswer {
  answers: string[];
}

export interface CodexSessionContext {
  session: ProviderSession;
  account: CodexAccountSnapshot;
  child: ChildProcessWithoutNullStreams;
  output: readline.Interface;
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  collabReceiverTurns: Map<string, TurnId>;
  nextRequestId: number;
  stopping: boolean;
}

export interface JsonRpcError {
  code?: number;
  message?: string;
}

export interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface CodexAppServerSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<
    { type: "image"; url: string } | { type: "file"; url: string }
  >;
  readonly model?: string;
  readonly serviceTier?: string | null;
  readonly effort?: string;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexAppServerStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "codex";
  readonly cwd?: string;
  readonly model?: string;
  readonly serviceTier?: string;
  readonly resumeCursor?: unknown;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly runtimeMode: RuntimeMode;
}

export interface CodexThreadTurnSnapshot {
  id: TurnId;
  items: unknown[];
}

export interface CodexThreadSnapshot {
  threadId: string;
  turns: CodexThreadTurnSnapshot[];
}

export interface CodexAppServerManagerEvents {
  event: [event: import("@bigbud/contracts").ProviderEvent];
}

// Re-export contract types used across modules
export type {
  ProviderUserInputAnswers,
  ProviderSession,
  RuntimeMode,
  ProviderInteractionMode,
  ProviderRequestKind,
};

/**
 * OpencodeAdapter types, interfaces, and constants.
 *
 * @module OpencodeAdapter.types
 */
import type {
  ThreadId,
  ThreadTokenUsageSnapshot,
  TurnId,
  ProviderSession,
} from "@bigbud/contracts";
import type { OpencodeClient, QuestionInfo } from "@opencode-ai/sdk/v2";
import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";

export const PROVIDER = "opencode" as const;

// ── Pending request tracking ──────────────────────────────────────────

export interface PendingPermissionRequest {
  readonly requestType:
    | "command_execution_approval"
    | "file_change_approval"
    | "file_read_approval"
    | "browser_approval"
    | "dynamic_tool_call"
    | "unknown";
  readonly turnId: TurnId | undefined;
  readonly requestId: string;
  responding: boolean;
}

/** Tracks an in-flight question.asked request awaiting a user answer. */
export interface PendingUserInputRequest {
  readonly turnId: TurnId | undefined;
  /** The structured questions from OpenCode. */
  readonly questions: ReadonlyArray<QuestionInfo>;
}

export interface MutableTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

export interface ActiveOpencodeSession {
  readonly client: OpencodeClient;
  /** Releases the shared server handle acquired from OpencodeServerManager. */
  readonly releaseServer: () => void;
  readonly opencodeSessionId: string;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly pendingPermissions: Map<string, PendingPermissionRequest>;
  readonly pendingUserInputs: Map<string, PendingUserInputRequest>;
  readonly turns: Array<MutableTurnSnapshot>;
  sseAbortController: AbortController | null;
  cwd: string | undefined;
  model: string | undefined;
  providerID: string | undefined;
  updatedAt: string;
  lastError: string | undefined;
  activeTurnId: TurnId | undefined;
  lastUsage: ThreadTokenUsageSnapshot | undefined;
  /** True while the session is in a retry/rate-limit back-off loop. */
  wasRetrying: boolean;
}

export interface OpencodeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

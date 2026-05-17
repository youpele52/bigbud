/**
 * CopilotAdapter types, interfaces, constants, and pure helper functions.
 *
 * @module CopilotAdapter.types
 */
import {
  EventId,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
} from "@bigbud/contracts";
import {
  type CopilotClientOptions,
  type CopilotSession,
  type SessionEvent,
} from "@github/copilot-sdk";

import { type EventNdjsonLogger } from "../EventNdjsonLogger.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../../Services/ProviderAdapter.ts";

export const PROVIDER = "copilot" as const;
export const DEFAULT_BINARY_PATH = "copilot";
export const USER_INPUT_QUESTION_ID = "answer";

export interface PendingApprovalRequest {
  readonly request: import("@github/copilot-sdk").PermissionRequest;
  readonly requestType:
    | "command_execution_approval"
    | "file_change_approval"
    | "file_read_approval"
    | "browser_approval"
    | "dynamic_tool_call"
    | "unknown";
  readonly turnId: TurnId | undefined;
  readonly resolve: (result: import("@github/copilot-sdk").PermissionRequestResult) => void;
}

export interface PendingUserInputRequest {
  readonly turnId: TurnId | undefined;
  readonly choices: ReadonlyArray<string>;
  readonly resolve: (result: CopilotUserInputResponse) => void;
}

export interface CopilotUserInputRequest {
  readonly question: string;
  readonly choices?: ReadonlyArray<string>;
  readonly allowFreeform?: boolean;
}

export interface CopilotUserInputResponse {
  readonly answer: string;
  readonly wasFreeform: boolean;
}

export interface MutableTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

export interface ActiveCopilotSession {
  readonly client: import("@github/copilot-sdk").CopilotClient;
  session: CopilotSession;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly providerRuntimeExecutionTargetId: ProviderSession["providerRuntimeExecutionTargetId"];
  readonly workspaceExecutionTargetId: ProviderSession["workspaceExecutionTargetId"];
  readonly pendingApprovals: Map<string, PendingApprovalRequest>;
  readonly pendingUserInputs: Map<string, PendingUserInputRequest>;
  readonly turns: Array<MutableTurnSnapshot>;
  /** Creates a fresh session to replace a stale one (e.g. after server restart). */
  readonly renewSession: () => Promise<CopilotSession>;
  readonly cleanupRemoteWorkspaceBridge?: () => Promise<void>;
  unsubscribe: () => void;
  cwd: string | undefined;
  model: string | undefined;
  updatedAt: string;
  lastError: string | undefined;
  activeTurnId: TurnId | undefined;
  activeMessageId: string | undefined;
  lastUsage: ThreadTokenUsageSnapshot | undefined;
  /**
   * Set to `true` by `stopSessionRecord` so that any in-flight auto-approve
   * timers can bail out early instead of calling into a torn-down session.
   */
  stopped: boolean;
}

export interface CopilotAdapterLiveOptions {
  readonly clientFactory?: (
    options: CopilotClientOptions,
  ) => import("@github/copilot-sdk").CopilotClient;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

/** Returns true when the Copilot CLI reports the session ID no longer exists (e.g. after a server restart). */
export function isSessionNotFoundError(cause: unknown): boolean {
  return cause instanceof Error && cause.message.toLowerCase().includes("session not found");
}

export function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function toRuntimeItemId(value: string | undefined): RuntimeItemId | undefined {
  return value ? RuntimeItemId.makeUnsafe(value) : undefined;
}

export function toRuntimeRequestId(value: string | undefined): RuntimeRequestId | undefined {
  return value ? RuntimeRequestId.makeUnsafe(value) : undefined;
}

export function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value ? ProviderItemId.makeUnsafe(value) : undefined;
}

export function normalizeUsage(
  event: Extract<SessionEvent, { type: "assistant.usage" }>,
): ThreadTokenUsageSnapshot {
  const inputTokens = event.data.inputTokens ?? 0;
  const outputTokens = event.data.outputTokens ?? 0;
  const cachedInputTokens = event.data.cacheReadTokens ?? 0;
  const usedTokens = inputTokens + outputTokens + cachedInputTokens;

  return {
    usedTokens,
    totalProcessedTokens: usedTokens,
    ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens > 0
      ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    ...(usedTokens > 0 ? { lastUsedTokens: usedTokens } : {}),
    ...(typeof event.data.duration === "number" ? { durationMs: event.data.duration } : {}),
  };
}

export function buildThreadSnapshot(
  threadId: ThreadId,
  turns: ReadonlyArray<MutableTurnSnapshot>,
): ProviderThreadSnapshot {
  return {
    threadId,
    turns: turns.map<ProviderThreadTurnSnapshot>((turn) => ({
      id: turn.id,
      items: [...turn.items],
    })),
  };
}

export function eventBase(input: {
  eventId: EventId;
  createdAt: string;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  raw?: ProviderRuntimeEvent["raw"];
}): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const providerTurnId = input.turnId;
  const providerItemId = toProviderItemId(input.itemId);
  const providerRequestId = normalizeString(input.requestId);

  return {
    eventId: input.eventId,
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: toRuntimeItemId(input.itemId) } : {}),
    ...(input.requestId ? { requestId: toRuntimeRequestId(input.requestId) } : {}),
    ...(providerTurnId || providerItemId || providerRequestId
      ? {
          providerRefs: {
            ...(providerTurnId ? { providerTurnId } : {}),
            ...(providerItemId ? { providerItemId } : {}),
            ...(providerRequestId ? { providerRequestId } : {}),
          },
        }
      : {}),
    ...(input.raw ? { raw: input.raw } : {}),
  };
}

export { makeNodeWrapperCliPath } from "./Adapter.types.cli.ts";
export {
  approvalDecisionToPermissionResult,
  getCopilotSessionApprovalMetadata,
  requestDetailFromPermissionRequest,
  requestTypeFromPermissionRequest,
  type CopilotSessionApprovalMetadata,
} from "./Adapter.types.approval.ts";

export function isCopilotModelSelection(
  value: unknown,
): value is Extract<
  NonNullable<import("@bigbud/contracts").ProviderSendTurnInput["modelSelection"]>,
  { provider: "copilot" }
> {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    value.provider === "copilot" &&
    "model" in value &&
    typeof value.model === "string"
  );
}

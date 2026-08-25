/**
 * ClaudeAdapter types, interfaces, and constants.
 *
 * @module ClaudeAdapter.types
 */
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionUpdate,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ApprovalRequestId,
  CanonicalItemType,
  CanonicalRequestType,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderUserInputAnswers,
  RuntimeContentStreamKind,
  ThreadId,
  ThreadTokenUsageSnapshot,
  TurnId,
  UserInputQuestion,
} from "@bigbud/contracts";
import type { Deferred, Effect, Fiber, Queue } from "effect";
import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";
import type { ProviderAdapterError, ProviderAdapterProcessError } from "../../Errors.ts";
import type { McpServerStatusEntry } from "@bigbud/contracts";
import type { ClaudeInterruptReceipt, ClaudeQueryRuntime } from "./Adapter.sdk.ts";
import type { ClaudeTaskState } from "./Adapter.tasks.ts";
import type { ClaudeRequestLedger } from "./Adapter.requestLedger.ts";

export type { ClaudeQueryRuntime } from "./Adapter.sdk.ts";

export const PROVIDER = "claudeAgent" as const;

type WithoutSessionEpoch<T> = T extends unknown ? Omit<T, "sessionEpoch"> : never;
export type UnstampedProviderRuntimeEvent = WithoutSessionEpoch<ProviderRuntimeEvent>;

export type ClaudeTextStreamKind = Extract<
  RuntimeContentStreamKind,
  "assistant_text" | "reasoning_text"
>;
export type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;

export type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

export interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
}

export interface ClaudeTurnState {
  readonly turnId: TurnId;
  /** Background SDK output may create a synthetic turn before the next prompt. */
  readonly synthetic: boolean;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  nextSyntheticAssistantBlockIndex: number;
}

export interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

export interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

export interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  cancelled: boolean;
  readonly sensitive?: boolean;
}

export interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
}

export interface ClaudeSessionContext {
  session: ProviderSession;
  readonly sessionEpoch: number;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  readonly cleanupRemoteWorkspaceBridge?: () => Promise<void>;
  streamFiber: Fiber.Fiber<void, unknown> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  effectivePermissionMode: PermissionMode | undefined;
  currentApiModelId: string | undefined;
  currentEffort: ClaudeQueryOptions["effort"] | undefined;
  currentFastMode: boolean;
  currentThinking: boolean | undefined;
  currentUltracode: boolean;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly resolvedApprovals: Map<ApprovalRequestId, ProviderApprovalDecision>;
  readonly resolvedApprovalSuggestions: Map<ApprovalRequestId, ReadonlyArray<PermissionUpdate>>;
  readonly requestLedger: ClaudeRequestLedger;
  readonly appliedSessionPermissionRequests: Set<ApprovalRequestId>;
  readonly resolvedUserInputs: Map<ApprovalRequestId, ProviderUserInputAnswers>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  readonly taskState: ClaudeTaskState;
  lastPlanFingerprint: string | undefined;
  turnState: ClaudeTurnState | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastAssistantUuid: string | undefined;
  lastInterruptReceipt: ClaudeInterruptReceipt | undefined;
  readonly queuedUserMessageIds: Set<string>;
  lastThreadStartedId: string | undefined;
  readonly seenNativeMessageIds: Set<string>;
  mcpStatuses: Array<McpServerStatusEntry>;
  readonly requiredMcpServerNames: ReadonlySet<string>;
  readonly modernTaskExposure: boolean;
  readonly mcpControlsEnabled: boolean;
  refreshMcpStatuses: (() => Effect.Effect<void, ProviderAdapterProcessError>) | undefined;
  recoverStream: (() => Effect.Effect<void, ProviderAdapterProcessError>) | undefined;
  recoveryInFlight: Promise<void> | undefined;
  recoveryAttempts: number;
  stopped: boolean;
}

export interface ClaudeAdapterLiveOptions {
  readonly harness?: ClaudeHarnessConfig;
  readonly resolveHarness?: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ClaudeHarnessConfig, ProviderAdapterError>;
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export interface ClaudeHarnessConfig {
  readonly binaryPath: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly settingSources?: ReadonlyArray<"user" | "project" | "local">;
  /** Harness-local rollout controls; native Claude settings must not leak into adapters. */
  readonly boundedHookProgress?: boolean;
  readonly forwardSubagentText?: boolean;
}

/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderActiveTurnInspection,
  ProviderApprovalDecision,
  ProviderKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  McpServerStatusEntry,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@bigbud/contracts";
import type { Effect } from "effect";
import type { Stream } from "effect";

export interface ProviderMcpOperations<TError> {
  readonly refresh: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<McpServerStatusEntry>, TError>;
  readonly reconnect: (threadId: ThreadId, serverName: string) => Effect.Effect<void, TError>;
  readonly toggle: (
    threadId: ThreadId,
    serverName: string,
    enabled: boolean,
  ) => Effect.Effect<void, TError>;
  readonly replace: (
    threadId: ThreadId,
    servers: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void, TError>;
}

export type ProviderSessionModelSwitchMode = "in-session" | "restart-session" | "unsupported";
export type ProviderSessionRecoveryMode =
  | "reinitialize"
  | "resume-restart"
  | "fresh-restart"
  | "unsupported";
export type ProviderConversationRewindMode = "transcript-and-files" | "files-only" | "unsupported";
export type ProviderConversationForkMode = "native" | "resume-copy" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /** Declares how a broken transport can recover without duplicating a session. */
  readonly sessionRecovery?: ProviderSessionRecoveryMode;
  /** Declares whether conversation rewind affects transcript state, files, or neither. */
  readonly conversationRewind?: ProviderConversationRewindMode;
  /** Declares whether the provider can create an isolated conversation fork. */
  readonly conversationFork?: ProviderConversationForkMode;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderKind;
  readonly capabilities: ProviderAdapterCapabilities;
  /** Provider-neutral MCP controls; omitted when the provider cannot support them. */
  readonly mcp?: ProviderMcpOperations<TError>;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /** Authoritative provider-native inspection, or `unavailable` when unsupported. */
  readonly inspectActiveTurn: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<ProviderActiveTurnInspection, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

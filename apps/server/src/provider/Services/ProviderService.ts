/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderInterruptTurnInput,
  ProviderActiveTurnInspection,
  ProviderKind,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ThreadId,
  ProviderTurnStartResult,
} from "@bigbud/contracts";
import type {
  ProviderTurnInspectionState,
  ProviderTurnLiveness,
} from "@bigbud/contracts/orchestration/providerTurnLiveness";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";

export interface ProviderSessionDiscoveryDiagnostic {
  readonly provider: ProviderKind | null;
  readonly source: "adapter" | "directory";
  readonly kind: "timeout" | "error";
  readonly detail: string;
}

export interface ProviderSessionDiscoveryResult {
  readonly sessions: ReadonlyArray<ProviderSession>;
  readonly availableProviders: ReadonlySet<ProviderKind>;
  readonly unavailableProviders: ReadonlySet<ProviderKind>;
  readonly directoryAvailable: boolean;
  readonly diagnostics: ReadonlyArray<ProviderSessionDiscoveryDiagnostic>;
}

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Start a provider session without automatically reusing persisted resume state.
   */
  readonly startSessionFresh: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly steerTurn?: (input: {
    readonly threadId: ThreadId;
    readonly input: string;
    readonly turnId?: import("@bigbud/contracts").TurnId;
    readonly sessionEpoch?: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  readonly inspectActiveTurn: (input: {
    readonly threadId: ThreadId;
    readonly turnId: import("@bigbud/contracts").TurnId;
    readonly sessionEpoch: number;
  }) => Effect.Effect<ProviderActiveTurnInspection, ProviderServiceError>;

  readonly listActiveTurnLiveness: () => Effect.Effect<ReadonlyArray<ProviderTurnLiveness>>;

  readonly recordTurnInspection: (input: {
    readonly threadId: ThreadId;
    readonly turnId: import("@bigbud/contracts").TurnId;
    readonly sessionEpoch: number;
    readonly observedAt: string;
    readonly status: ProviderTurnInspectionState;
    readonly failed: boolean;
  }) => Effect.Effect<void>;

  readonly claimTurnTerminal: (input: {
    readonly threadId: ThreadId;
    readonly turnId: import("@bigbud/contracts").TurnId;
    readonly provider: ProviderKind;
    readonly sessionEpoch: number;
    readonly terminalAt: string;
  }) => Effect.Effect<boolean>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /** Failure-isolated provider discovery used only by reconciliation. */
  readonly listSessionsForReconciliation: () => Effect.Effect<ProviderSessionDiscoveryResult>;

  /**
   * Read static capabilities for a provider adapter.
   */
  readonly getCapabilities: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends ServiceMap.Service<ProviderService, ProviderServiceShape>()(
  "t3/provider/Services/ProviderService",
) {}

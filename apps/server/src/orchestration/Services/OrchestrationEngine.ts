/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `ServiceMap.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  OrchestrationCommand,
  CommandId,
  GetCommandOutcomeResult,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationReplayEventsResult,
  GetThreadOwnershipResult,
  OrchestrationThread,
  ThreadId,
} from "@bigbud/contracts";
import { Effect, ServiceMap } from "effect";
import type { Scope, Stream } from "effect";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";
import type { OrchestrationCommandReceiptRepositoryError } from "../../persistence/Errors.ts";
import type { ThreadDeletionShape } from "../../deletion/Services/ThreadDeletion.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /** Shared deletion fence and subtree operation for orchestration reactors. */
  readonly threadDeletion?: ThreadDeletionShape;

  /**
   * Read the current in-memory orchestration read model.
   *
   * @returns Effect containing the latest read model.
   */
  readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, never, never>;

  readonly ensureThreadState?: (
    threadId: ThreadId,
    level: "operational" | "history",
  ) => Effect.Effect<OrchestrationThread | undefined>;

  readonly resolveThreadOwnership?: (threadId: ThreadId) => Effect.Effect<GetThreadOwnershipResult>;

  readonly getCommandOutcome?: (
    commandId: CommandId,
  ) => Effect.Effect<GetCommandOutcomeResult, OrchestrationCommandReceiptRepositoryError>;

  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  readonly readReplay: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Effect.Effect<OrchestrationReplayEventsResult, OrchestrationEventStoreError>;

  /** Opens an engine-owned bounded live capture for one delivery consumer. */
  readonly openDeliveryLiveCapture?: (
    capacity?: number,
  ) => Effect.Effect<Stream.Stream<OrchestrationEvent>, never, Scope.Scope>;

  /** Internal keyed lookup for the event set committed by one command. */
  readonly readEventsByCommandId?: (
    commandId: CommandId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, OrchestrationEventStoreError>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;
}

export function ensureOrchestrationThreadState(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
  level: "operational" | "history",
) {
  return engine.ensureThreadState
    ? engine.ensureThreadState(threadId, level)
    : engine
        .getReadModel()
        .pipe(Effect.map((model) => model.threads.find((thread) => thread.id === threadId)));
}

export function resolveOrchestrationThreadOwnership(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
) {
  return engine.resolveThreadOwnership
    ? engine.resolveThreadOwnership(threadId)
    : Effect.succeed({
        threadId,
        status: "unavailable" as const,
        ownership: "unconfirmed" as const,
        reason: "Canonical ownership resolution is unavailable.",
      });
}

export function getOrchestrationCommandOutcome(
  engine: OrchestrationEngineShape,
  commandId: CommandId,
) {
  return engine.getCommandOutcome
    ? engine.getCommandOutcome(commandId)
    : Effect.succeed({
        commandId,
        status: "unknown" as const,
        serverEpoch: "unavailable",
        canonicalRevision: 0,
      });
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.getReadModel()
 * })
 * ```
 */
export class OrchestrationEngineService extends ServiceMap.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}

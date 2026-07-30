/**
 * OrchestrationEventStore - Event store interface for orchestration events.
 *
 * Owns durable append/replay access to the orchestration event stream. It does
 * not reduce events into read models or apply command validation rules.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and exposes typed
 * persistence/decode errors for event append and replay operations.
 *
 * @module OrchestrationEventStore
 */
import {
  OrchestrationEvent,
  type OrchestrationReplayEventsResult,
  ThreadId,
  ProjectId,
} from "@bigbud/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { OrchestrationEventStoreError } from "../Errors.ts";

/**
 * OrchestrationEventStoreShape - Service API for orchestration event persistence.
 */
export interface OrchestrationEventStoreShape {
  /**
   * Persist a new orchestration event.
   *
   * @param event - Event payload without sequence (assigned by storage).
   * @returns Effect containing the stored event with assigned sequence.
   *
   * Actor kind is inferred from command/metadata before persistence.
   */
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Replay events after the provided sequence.
   *
   * @param sequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to emit.
   * @returns Stream containing ordered events.
   *
   * Reads in fixed-size pages and normalizes non-integer/negative limits.
   */
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /** Read one replay page together with authoritative retained-range metadata. */
  readonly readReplay: (
    sequenceExclusive: number,
    limit?: number,
  ) => Effect.Effect<OrchestrationReplayEventsResult, OrchestrationEventStoreError>;

  /** Delete at most one bounded canonical prefix covered by a verified baseline. */
  readonly compactVerifiedPrefix?: (batchSize?: number) => Effect.Effect<
    {
      readonly deletedCount: number;
      readonly retainedThroughSequence: number;
      readonly compactThroughSequence: number;
      readonly complete: boolean;
    },
    OrchestrationEventStoreError
  >;

  /** Resolve a thread's durable project identity, including deleted threads. */
  readonly findThreadProjectId: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectId>, OrchestrationEventStoreError>;

  /**
   * Read all events from the beginning of the stream.
   *
   * @returns Stream containing all stored events.
   */
  readonly readAll: () => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;
}

/**
 * OrchestrationEventStore - Service tag for orchestration event persistence.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const events = yield* OrchestrationEventStore
 *   return yield* Stream.runCollect(events.readAll())
 * })
 * ```
 */
export class OrchestrationEventStore extends ServiceMap.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("t3/persistence/Services/OrchestrationEventStore") {}

/**
 * ProviderTurnSupervisor - the single turn health and sleep recovery coordinator.
 *
 * Keeps today's turn health projections (checking, stalled, lost session) and owns sleep and
 * wake recovery: it classifies turns cut by a sleep, observes providers that continue on
 * their own, continues a cut turn once when that is safe, and asks the user when a tool may
 * have been running. It is the only recovery loop; it is started by the orchestration reactor.
 *
 * @module ProviderTurnSupervisor
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ProviderTurnSupervisorShape {
  /** Starts the 5 s tick and the event observers. Must run in a scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Runs one health and recovery pass now. */
  readonly runPass: Effect.Effect<void>;
}

export class ProviderTurnSupervisor extends ServiceMap.Service<
  ProviderTurnSupervisor,
  ProviderTurnSupervisorShape
>()("bigbud/orchestration/Services/ProviderTurnSupervisor") {}

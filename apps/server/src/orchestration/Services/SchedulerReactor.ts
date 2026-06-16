import { type AutomationId } from "@bigbud/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

/**
 * SchedulerReactorShape - Service API for the automation scheduler lifecycle.
 */
export interface SchedulerReactorShape {
  /**
   * Start the background scheduler tick loop.
   *
   * The reactor ticks on an interval, queries due automation schedules from
   * SQLite, atomically claims them with a lease, and dispatches
   * `thread.turn.start` commands into the orchestration engine.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Dispatch a specific automation immediately.
   */
  readonly triggerNow: (automationId: AutomationId) => Effect.Effect<void>;
}

/**
 * SchedulerReactor - Service tag for the automation scheduler reactor.
 */
export class SchedulerReactor extends ServiceMap.Service<SchedulerReactor, SchedulerReactorShape>()(
  "t3/orchestration/Services/SchedulerReactor/SchedulerReactor",
) {}

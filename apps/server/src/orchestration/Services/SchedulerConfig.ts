import { ServiceMap } from "effect";
import type { Duration } from "effect";

/**
 * SchedulerConfigShape - Configuration for the automation scheduler reactor.
 */
export interface SchedulerConfigShape {
  /**
   * Interval between scheduler ticks.
   */
  readonly tickInterval: Duration.Duration;

  /**
   * Duration for which a claimed schedule is leased to prevent concurrent runs.
   */
  readonly leaseDuration: Duration.Duration;

  /**
   * Maximum number of schedules to claim in one tick.
   */
  readonly claimBatchSize: number;

  /**
   * Maximum concurrent dispatches per tick.
   */
  readonly maxConcurrency: number;

  /**
   * Maximum age for a started run before it is marked failed.
   */
  readonly staleRunTimeout: Duration.Duration;

  /**
   * Interval between reconciliation passes for started runs.
   */
  readonly reconcileInterval: Duration.Duration;

  /**
   * Maximum started runs to reconcile per pass.
   */
  readonly reconcileBatchSize: number;
}

/**
 * SchedulerConfig - Service tag for scheduler configuration.
 */
export class SchedulerConfig extends ServiceMap.Service<SchedulerConfig, SchedulerConfigShape>()(
  "t3/orchestration/Services/SchedulerConfig/SchedulerConfig",
) {}

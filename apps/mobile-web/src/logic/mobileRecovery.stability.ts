import type { MobileRecoveryFreshness, RecoveryScheduler } from "./mobileRecovery.types";

/**
 * Plan 3.7: replenish retries after 30 continuous seconds of current/legacy success.
 * This exceeds the 20s attempt deadline and 3.5s retry ladder, so brief catch-up
 * during churn cannot replenish retries. An independent later outage can recover.
 * Every new attempt, disconnect, failure, or disposal cancels this success window.
 */
export const MOBILE_RECOVERY_STABLE_SUCCESS_MS = 30_000;

export function createMobileRecoveryStabilityTimer(
  scheduler: RecoveryScheduler,
  onStable: () => void,
) {
  let timer: number | null = null;
  let successWindowActive = false;
  let generation = 0;

  function cancel() {
    generation += 1;
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
    successWindowActive = false;
  }

  return {
    cancel,
    update(freshness: MobileRecoveryFreshness) {
      if (freshness !== "current" && freshness !== "legacy") {
        cancel();
        return;
      }
      if (successWindowActive) return;
      successWindowActive = true;
      const runGeneration = generation;
      timer = scheduler.setTimeout(() => {
        if (runGeneration !== generation) return;
        timer = null;
        onStable();
      }, MOBILE_RECOVERY_STABLE_SUCCESS_MS);
    },
  };
}

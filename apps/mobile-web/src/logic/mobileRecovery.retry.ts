import {
  MAX_RETRY_ATTEMPTS,
  RETRY_DELAYS_MS,
  type RecoveryScheduler,
} from "./mobileRecovery.types";

/** Recovery retries wait for transport; socket reconnects have their own single owner. */
export function createMobileRecoveryRetry(
  scheduler: RecoveryScheduler,
  canRetry: () => boolean,
  run: () => Promise<unknown>,
) {
  let ordinal = 0;
  let timer: number | null = null;
  return {
    get pending() {
      return timer !== null;
    },
    reset() {
      ordinal = 0;
    },
    clear() {
      if (timer !== null) scheduler.clearTimeout(timer);
      timer = null;
    },
    schedule() {
      if (!canRetry() || timer !== null || ordinal >= MAX_RETRY_ATTEMPTS) return;
      const delay = RETRY_DELAYS_MS[ordinal++] ?? RETRY_DELAYS_MS.at(-1)!;
      timer = scheduler.setTimeout(() => {
        timer = null;
        if (canRetry()) void run().catch(() => undefined);
      }, delay);
    },
  };
}

export const WS_RECONNECT_INITIAL_DELAY_MS = 1_000;
export const WS_RECONNECT_BACKOFF_FACTOR = 2;
export const WS_RECONNECT_MAX_DELAY_MS = 30_000;
/** Label-only cap: attempts past it render as "Attempt k" while retries continue. */
export const WS_RECONNECT_LABEL_MAX_ATTEMPTS = 8;

/** Exponential ceiling for one retry, from 1 s up to the 30 s cap. */
export function getWsReconnectBackoffCeilingMs(retryIndex: number): number {
  const index = Number.isFinite(retryIndex) ? Math.max(0, Math.floor(retryIndex)) : 0;
  // Clamp the exponent so long outages never overflow to Infinity.
  const exponent = Math.min(index, 32);
  return Math.min(
    WS_RECONNECT_MAX_DELAY_MS,
    Math.round(WS_RECONNECT_INITIAL_DELAY_MS * WS_RECONNECT_BACKOFF_FACTOR ** exponent),
  );
}

/** Full jitter: a uniform delay in [0, ceiling] so independent windows never retry in lockstep. */
export function getWsReconnectDelayMs(retryIndex: number, random: () => number = Math.random) {
  const sample = Math.min(1, Math.max(0, random()));
  return Math.round(getWsReconnectBackoffCeilingMs(retryIndex) * sample);
}

/**
 * Owns one transport's unbounded reconnect backoff. The index resets when a socket opens,
 * and `wake` lets OS, visibility and readiness signals skip the current wait.
 */
export class WsReconnectBackoff {
  private retryIndex = 0;
  private skipNextWait = false;
  private readonly sleepers = new Set<() => void>();

  constructor(private readonly random: () => number = Math.random) {}

  nextDelayMs(): number {
    const delayMs = getWsReconnectDelayMs(this.retryIndex, this.random);
    this.retryIndex += 1;
    return delayMs;
  }

  reset(): void {
    this.retryIndex = 0;
    this.skipNextWait = false;
  }

  get isWaiting(): boolean {
    return this.sleepers.size > 0;
  }

  /** Resolves after `ms`, on `wake`, or on abort, whichever happens first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted || this.skipNextWait) {
        this.skipNextWait = false;
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        this.sleepers.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      this.sleepers.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  /**
   * Skips the current backoff wait and restarts the ladder. Between waits (a socket just
   * closed, or a retired session is still closing) the next wait is skipped instead.
   */
  wake(): void {
    this.retryIndex = 0;
    if (this.sleepers.size === 0) {
      this.skipNextWait = true;
      return;
    }
    // Each `finish` deletes itself; deleting the visited entry keeps Set iteration valid.
    for (const finish of this.sleepers) finish();
  }
}

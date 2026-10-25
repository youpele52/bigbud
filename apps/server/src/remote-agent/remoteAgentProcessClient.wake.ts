/**
 * Wake signal for delayed remote-process reattach.
 *
 * After its immediate attempts fail, a reattaching process client waits for
 * the network to come back or the machine to wake before retrying early. The
 * server's sleep-epoch service calls `notifyRemoteAgentReattachWake` on its
 * `network-online` and `epoch-ended` events; without that bridge the client
 * still retries on its jittered backoff, only less promptly.
 */
const waiters = new Set<() => void>();

/** Wakes every reattach currently waiting for the network or a sleep to end. */
export function notifyRemoteAgentReattachWake(): void {
  const current = [...waiters];
  waiters.clear();
  for (const wake of current) wake();
}

/** Resolves on the next wake notification, or when `signal` aborts. */
export function waitForRemoteAgentReattachWake(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const wake = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      waiters.delete(wake);
      resolve();
    };
    waiters.add(wake);
    signal.addEventListener("abort", abort, { once: true });
  });
}

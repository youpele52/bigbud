/** Bounds timer ownership to a live subscription or transport. */
export function waitForWsRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Retains logical subscribers after exhaustion without scheduling automatic recovery. */
export function waitForExplicitWsRecovery(
  waiters: Set<() => void>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      waiters.delete(finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    waiters.add(finish);
    signal.addEventListener("abort", finish, { once: true });
  });
}

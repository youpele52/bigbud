/** Upper bound for thread-tools retirement during backend shutdown. A missed bound or failure
 * leaves the signed records for dead-backend recovery on the next start; it never holds
 * shutdown hostage. */
export const V2_THREAD_TOOLS_SHUTDOWN_MS = 5000;

export function v2ShutdownSignal() {
  return AbortSignal.timeout(V2_THREAD_TOOLS_SHUTDOWN_MS);
}

/** Resolves when `work` settles or `signal` aborts, whichever is first; never rejects. `work` is
 * always observed, so a retirement that fails after the bound is never an unhandled rejection. */
export function settleWithinShutdown(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    work.then(done, done);
    if (signal.aborted) return done();
    signal.addEventListener("abort", done, { once: true });
  });
}

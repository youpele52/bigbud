/**
 * Bounded process exit after a committed upgrade drain (W3.4). The drain's
 * shutdown request completes the server fiber, but `NodeRuntime.runMain` only
 * calls `process.exit` on a signal or a non-zero exit; a clean completion waits
 * for the event loop to drain. Known keep-alive leaks (the SQLite worker
 * bridge's exit timer and ThreadRetention's detached recovery loop) are fixed,
 * so a drained process normally exits in about a second. This timer is a safety
 * net against future leaks: the marker and record are already committed and
 * the WAL checkpointed, so after a graceful window the process exits 0.
 *
 * @module backendDrain.exit
 */
export const BACKEND_DRAIN_EXIT_DEADLINE_MS = 12_000;

let armed: ReturnType<typeof setTimeout> | undefined;

/** Arms one unref'd hard-exit timer; a process that drains naturally exits first. */
export function armBackendDrainExit(
  deadlineMs: number = BACKEND_DRAIN_EXIT_DEADLINE_MS,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  if (armed) return;
  armed = setTimeout(() => {
    console.warn(
      `[backend-drain] graceful shutdown exceeded ${deadlineMs} ms after a committed drain; exiting.`,
    );
    exit(0);
  }, deadlineMs);
  armed.unref();
}

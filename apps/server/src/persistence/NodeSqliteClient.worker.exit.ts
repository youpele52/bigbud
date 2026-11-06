/**
 * What the server does when its SQLite worker dies underneath an open connection.
 *
 * The bridge cannot restart the worker (an open transaction would not survive it), so after
 * such a failure every query would fail while the HTTP and WebSocket servers kept answering:
 * a backend that looks alive and does nothing. Exiting instead is loud and recoverable: the
 * desktop restarts the backend with `unexpected-exit-restart`, which prompts for every turn
 * whose outcome the crash left unknown.
 *
 * @module NodeSqliteClient.worker.exit
 */
import type { NodeSqliteWorkerBridgeFailure } from "./NodeSqliteClient.worker.bridge.ts";

/** Exit status for a lost SQLite worker, distinct from Node's own fatal codes. */
export const SQLITE_WORKER_FAILURE_EXIT_CODE = 70;

/** Upper bound on waiting for the stderr write before exiting anyway. */
const EXIT_FLUSH_TIMEOUT_MS = 1_000;

export interface SqliteWorkerFailureExitOptions {
  readonly writeStderr: (line: string, done: () => void) => void;
  readonly exit: (code: number) => void;
}

const defaultOptions: SqliteWorkerFailureExitOptions = {
  writeStderr: (line, done) => {
    process.stderr.write(line, () => done());
  },
  exit: (code) => process.exit(code),
};

/**
 * Logs the failure to stderr (where the desktop captures backend output) and exits. The write
 * callback or a short timer, whichever is first, triggers the exit, since pipes on macOS are
 * asynchronous and a synchronous exit could drop the only record of the cause.
 */
export function exitProcessOnSqliteWorkerFailure(
  failure: NodeSqliteWorkerBridgeFailure,
  options: SqliteWorkerFailureExitOptions = defaultOptions,
): void {
  let exited = false;
  const exitOnce = () => {
    if (exited) return;
    exited = true;
    options.exit(SQLITE_WORKER_FAILURE_EXIT_CODE);
  };
  const timer = setTimeout(exitOnce, EXIT_FLUSH_TIMEOUT_MS);
  timer.unref();
  options.writeStderr(
    `FATAL: ${failure.message} The SQLite worker cannot be restarted in place; exiting with code ${SQLITE_WORKER_FAILURE_EXIT_CODE} so the supervisor can restart the backend.\n`,
    () => {
      clearTimeout(timer);
      exitOnce();
    },
  );
}

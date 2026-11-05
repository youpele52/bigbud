/**
 * POSIX process and process-group signalling by number, for children the server no longer holds a
 * handle to (bounded ACP release, startup orphan reaping). Callers prove identity first: these
 * helpers signal whatever currently owns the PID or PGID.
 *
 * @module processGroup
 */

/** True while any process is left in the group (EPERM: the PGID now names someone else's). */
export function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True while `pid` exists, including another user's process (EPERM). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Signal every process in the group; a group that is already gone is not an error. */
export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* Already gone. */
  }
}

/** Signal one process; a process that is already gone is not an error. */
export function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* Already gone. */
  }
}

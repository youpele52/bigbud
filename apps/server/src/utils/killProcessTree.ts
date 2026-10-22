import { spawn } from "node:child_process";

/** Upper bound for `taskkill` itself, so a wedged kill never lingers. */
const TASKKILL_TIMEOUT_MS = 10_000;

export interface KillableProcess {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

interface TaskkillProcess {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
}

export interface KillProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  /** Injectable for tests; defaults to `child_process.spawn`. */
  readonly spawnTaskkill?: (command: string, args: ReadonlyArray<string>) => TaskkillProcess;
}

const spawnTaskkillDefault = (command: string, args: ReadonlyArray<string>): TaskkillProcess =>
  spawn(command, [...args], { stdio: "ignore", windowsHide: true });

/**
 * Terminates a child and, on Windows, its whole process tree without blocking
 * the event loop. With `shell: true`, `child.kill()` alone would only end the
 * `cmd.exe` wrapper, so Windows uses an asynchronous `taskkill /T /F` and falls
 * back to a direct kill when `taskkill` cannot start or does not succeed.
 */
export function killProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals = "SIGTERM",
  options: KillProcessTreeOptions = {},
): void {
  if ((options.platform ?? process.platform) !== "win32" || child.pid === undefined) {
    child.kill(signal);
    return;
  }
  let killer: TaskkillProcess;
  try {
    killer = (options.spawnTaskkill ?? spawnTaskkillDefault)("taskkill", [
      "/pid",
      String(child.pid),
      "/T",
      "/F",
    ]);
  } catch {
    child.kill(signal);
    return;
  }
  const timer = setTimeout(() => killer.kill(), TASKKILL_TIMEOUT_MS);
  timer.unref();
  killer.once("error", () => {
    clearTimeout(timer);
    child.kill(signal);
  });
  killer.once("exit", (code) => {
    clearTimeout(timer);
    if (code !== 0) child.kill(signal);
  });
}

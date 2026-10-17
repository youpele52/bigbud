import { spawn, type ChildProcess } from "node:child_process";

export interface WindowsTreeCleanup {
  readonly result: Promise<boolean>;
  dispose(): void;
}

/** Bounded taskkill for a trusted, still-owned test tree; not a Job Object custody proof. */
export function beginWindowsTreeCleanup(
  child: ChildProcess,
  identityHeld: () => boolean,
  deadline: number,
  launch: typeof spawn = spawn,
): WindowsTreeCleanup {
  let helper: ChildProcess | undefined;
  let settled = false;
  let killAttempted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete: ((confirmed: boolean) => void) | undefined;
  const dispose = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (helper) {
      // Handle-owned helper only, no numeric PID retry or taskkill-on-taskkill.
      if (!killAttempted && helper.exitCode === null && helper.signalCode === null) {
        killAttempted = true;
        try {
          helper.kill("SIGKILL");
        } catch {
          /* Unconfirmed either way. */
        }
      }
      helper.unref();
    }
    complete?.(false);
  };
  const result = new Promise<boolean>((resolve) => {
    complete = resolve;
    const pid = child.pid;
    if (
      !Number.isSafeInteger(pid) ||
      pid === undefined ||
      pid <= 1 ||
      pid > 0xffff_ffff ||
      pid === process.pid ||
      pid === process.ppid ||
      !identityHeld() ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      !Number.isFinite(deadline) ||
      performance.now() >= deadline
    ) {
      dispose();
      return;
    }
    try {
      // No await between retained-identity validation and action; arguments are numeric only.
      helper = launch("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      helper.once("error", dispose);
      helper.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        helper?.unref();
        resolve(code === 0 && signal === null && performance.now() < deadline);
      });
      // Helper CPU/wall lifetime cannot extend the executor's existing join deadline.
      timer = setTimeout(dispose, Math.max(0, deadline - performance.now()));
    } catch {
      dispose();
    }
  });
  return { result, dispose };
}

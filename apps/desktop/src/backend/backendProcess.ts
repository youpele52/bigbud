import * as ChildProcess from "node:child_process";

const WINDOWS_TREE_KILL_TIMEOUT_MS = 5_000;

export function killWindowsProcessTree(pid: number): {
  readonly treeTerminationConfirmed: boolean;
} {
  try {
    const result = ChildProcess.spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: WINDOWS_TREE_KILL_TIMEOUT_MS,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return { treeTerminationConfirmed: true };
    console.warn(
      `[desktop] taskkill failed for process tree pid=${pid} status=${result.status ?? "null"}.`,
    );
  } catch {
    console.warn(`[desktop] taskkill could not run for process tree pid=${pid}.`);
  }
  return { treeTerminationConfirmed: false };
}

export function killProcessTree(
  child: ChildProcess.ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): { readonly treeTerminationConfirmed: boolean } {
  if (process.platform === "win32" && child.pid !== undefined) {
    const result = killWindowsProcessTree(child.pid);
    if (result.treeTerminationConfirmed) return result;
    console.warn(`[desktop] Falling back to direct ${signal} for process pid=${child.pid}.`);
  }
  try {
    child.kill(signal);
  } catch (error: unknown) {
    console.warn(
      `[desktop] Direct ${signal} failed for process pid=${child.pid ?? "unknown"}; waiting for confirmed exit.`,
      error,
    );
  }
  return { treeTerminationConfirmed: process.platform !== "win32" };
}

export const killBackendProcess = killProcessTree;

import type * as ChildProcess from "node:child_process";

import { killProcessTree } from "./backendProcess";
import { recordInstalledProcessTreeUncertainty } from "./installedProcessQuiescence";

const FORCE_KILL_DELAY_MS = 2_000;

/**
 * Backend SIGTERM-to-SIGKILL window. On SIGTERM the server stops its provider sessions, and one
 * ACP agent stop takes up to about 5 s (see `ACP_SESSION_STOP_WAIT` in the server's
 * `provider/acp/AcpSessionStop.ts`). A SIGKILL before that orphans the agents, which run in their
 * own process groups, so the backend gets that budget plus room for the rest of its teardown.
 */
export const BACKEND_FORCE_KILL_DELAY_MS = 8_000;
/** Default wait for a backend stop to finish: the force-kill window plus the SIGKILL exit. */
export const BACKEND_STOP_WAIT_TIMEOUT_MS = BACKEND_FORCE_KILL_DELAY_MS + 2_000;

export function stopChildProcessTree(
  child: ChildProcess.ChildProcess,
  expectedChildren: WeakSet<ChildProcess.ChildProcess>,
  forceKillDelayMs = FORCE_KILL_DELAY_MS,
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  expectedChildren.add(child);
  killProcessTree(child);
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      killProcessTree(child, "SIGKILL");
    }
  }, forceKillDelayMs).unref();
}

export async function stopChildProcessTreeAndWait(
  child: ChildProcess.ChildProcess,
  expectedChildren: WeakSet<ChildProcess.ChildProcess>,
  timeoutMs: number,
  forceKillDelayMs = FORCE_KILL_DELAY_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  expectedChildren.add(child);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let exitObserved = false;
    let killAttemptComplete = false;
    let treeUncertaintyError: Error | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      child.off("close", onExit);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (exitTimeoutTimer) clearTimeout(exitTimeoutTimer);
      if (error) reject(error);
      else resolve();
    };
    const settleConfirmedExit = () => {
      if (!exitObserved || !killAttemptComplete) return;
      if (treeUncertaintyError) {
        settle(treeUncertaintyError);
        return;
      }
      settle();
    };
    const onExit = () => {
      exitObserved = true;
      settleConfirmedExit();
    };
    const terminate = (signal: NodeJS.Signals) => {
      killAttemptComplete = false;
      const result = killProcessTree(child, signal);
      if (process.platform === "win32" && !result.treeTerminationConfirmed) {
        treeUncertaintyError ??= new Error(
          `Windows could not confirm process tree termination for pid=${child.pid ?? "unknown"}; updater handoff is unsafe until bigbud restarts.`,
        );
        recordInstalledProcessTreeUncertainty(treeUncertaintyError);
      }
      killAttemptComplete = true;
      settleConfirmedExit();
    };
    child.once("exit", onExit);
    child.once("close", onExit);
    terminate("SIGTERM");
    if (settled) return;
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        terminate("SIGKILL");
      }
    }, forceKillDelayMs);
    forceKillTimer.unref();
    exitTimeoutTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        exitObserved = true;
        settleConfirmedExit();
        return;
      }
      settle(
        new Error(`Process tree pid=${child.pid ?? "unknown"} did not exit within ${timeoutMs}ms.`),
      );
    }, timeoutMs);
    exitTimeoutTimer.unref();
  });
}

export const stopBackendChild = (
  child: ChildProcess.ChildProcess,
  expectedChildren: WeakSet<ChildProcess.ChildProcess>,
): void => stopChildProcessTree(child, expectedChildren, BACKEND_FORCE_KILL_DELAY_MS);

export const stopBackendChildAndWait = (
  child: ChildProcess.ChildProcess,
  expectedChildren: WeakSet<ChildProcess.ChildProcess>,
  timeoutMs: number = BACKEND_STOP_WAIT_TIMEOUT_MS,
): Promise<void> =>
  stopChildProcessTreeAndWait(child, expectedChildren, timeoutMs, BACKEND_FORCE_KILL_DELAY_MS);

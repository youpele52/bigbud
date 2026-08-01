import type * as ChildProcess from "node:child_process";

import { killBackendProcess } from "./backendProcess";

export function stopBackendChild(
  child: ChildProcess.ChildProcess,
  expectedChildren: WeakSet<ChildProcess.ChildProcess>,
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  expectedChildren.add(child);
  killBackendProcess(child);
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      killBackendProcess(child, "SIGKILL");
    }
  }, 2_000).unref();
}

export async function stopBackendChildAndWait(
  child: ChildProcess.ChildProcess,
  expectedChildren: WeakSet<ChildProcess.ChildProcess>,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  expectedChildren.add(child);
  await new Promise<void>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (exitTimeoutTimer) clearTimeout(exitTimeoutTimer);
      resolve();
    };
    const onExit = () => settle();
    child.once("exit", onExit);
    killBackendProcess(child);
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        killBackendProcess(child, "SIGKILL");
      }
    }, 2_000);
    forceKillTimer.unref();
    exitTimeoutTimer = setTimeout(settle, timeoutMs);
    exitTimeoutTimer.unref();
  });
}

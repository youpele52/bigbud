import type * as ChildProcess from "node:child_process";

import { killProcessTree } from "./backendProcess";
import { stopChildProcessTreeAndWait } from "./backendShutdown";
import { assertInstalledProcessStartsAllowed } from "./installedProcessQuiescence";

const activeChildren = new Set<ChildProcess.ChildProcess>();
const expectedChildren = new WeakSet<ChildProcess.ChildProcess>();
let stopPromise: Promise<void> | null = null;

export function assertCuaDriverProcessStartAllowed(description: string): void {
  assertInstalledProcessStartsAllowed(description);
}

export function trackCuaDriverProcess<T extends ChildProcess.ChildProcess>(child: T): T {
  activeChildren.add(child);
  const forgetChild = () => activeChildren.delete(child);
  child.once("exit", forgetChild);
  child.once("close", forgetChild);
  return child;
}

export function stopTrackedCuaDriverProcess(child: ChildProcess.ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  expectedChildren.add(child);
  killProcessTree(child);
}

export function stopTrackedCuaDriverProcessesAndWait(timeoutMs = 5_000): Promise<void> {
  if (stopPromise) return stopPromise;
  const children = [...activeChildren];
  if (children.length === 0) return Promise.resolve();
  const request = (async () => {
    const results = await Promise.allSettled(
      children.map((child) => stopChildProcessTreeAndWait(child, expectedChildren, timeoutMs)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Could not confirm auxiliary cua-driver process shutdown.");
    }
  })();
  stopPromise = request;
  const clearRequest = () => {
    if (stopPromise === request) stopPromise = null;
  };
  void request.then(clearRequest, clearRequest);
  return request;
}

export function stopTrackedCuaDriverProcesses(): void {
  void stopTrackedCuaDriverProcessesAndWait().catch((error: unknown) => {
    console.error(`[desktop] Failed to confirm auxiliary cua-driver shutdown: ${String(error)}`);
  });
}

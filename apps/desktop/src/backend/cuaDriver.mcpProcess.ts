import type * as ChildProcess from "node:child_process";

import {
  assertCuaDriverProcessStartAllowed,
  stopTrackedCuaDriverProcess,
  stopTrackedCuaDriverProcesses,
  stopTrackedCuaDriverProcessesAndWait,
  trackCuaDriverProcess,
} from "./cuaDriver.processRegistry";

export function assertCuaDriverMcpStartAllowed(): void {
  assertCuaDriverProcessStartAllowed("cua-driver MCP client");
}

export function trackCuaDriverMcpChild<T extends ChildProcess.ChildProcess>(child: T): T {
  return trackCuaDriverProcess(child);
}

export function stopCuaDriverMcpProcess(child: ChildProcess.ChildProcess): void {
  stopTrackedCuaDriverProcess(child);
}

export function stopCuaDriverMcpProcessesAndWait(timeoutMs = 5_000): Promise<void> {
  return stopTrackedCuaDriverProcessesAndWait(timeoutMs);
}

export function stopCuaDriverMcpProcesses(): void {
  stopTrackedCuaDriverProcesses();
}

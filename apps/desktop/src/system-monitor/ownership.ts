import type { ChildProcess } from "node:child_process";
import { app } from "electron";
import type { MonitorProcessRoot } from "@bigbud/contracts/system-monitor/types";
import { backendProcess } from "../backend/backendManager";

let nextIdentity = 0;
const children = new WeakMap<ChildProcess, string>();

/** Child-handle identity changes on restart even if the OS reuses its PID. */
export function ownedChildRoot(
  child: ChildProcess | null,
  role: MonitorProcessRoot["role"],
): MonitorProcessRoot | null {
  if (!child?.pid || child.exitCode !== null || child.killed) return null;
  let identity = children.get(child);
  if (!identity) {
    identity = `child:${++nextIdentity}`;
    children.set(child, identity);
  }
  return { pid: child.pid, identity, role };
}

/** Ownership comes from Electron and live child handles, never renderer-supplied PIDs. */
export function getDesktopMonitorRoots(monitor: ChildProcess | null): MonitorProcessRoot[] {
  const roots = new Map<number, MonitorProcessRoot>();
  for (const metric of app.getAppMetrics()) {
    const startTimeSeconds = Math.floor(metric.creationTime / 1000);
    if (!Number.isSafeInteger(startTimeSeconds) || startTimeSeconds <= 0) continue;
    roots.set(metric.pid, {
      pid: metric.pid,
      identity: `electron:${metric.pid}:${metric.creationTime}`,
      startTimeSeconds,
      role: "desktop",
    });
  }
  if (!roots.has(process.pid)) {
    roots.set(process.pid, { pid: process.pid, identity: "desktop-owner", role: "desktop" });
  }
  for (const root of [
    ownedChildRoot(backendProcess, "backend"),
    ownedChildRoot(monitor, "native"),
  ]) {
    if (root) roots.set(root.pid, root);
  }
  if (roots.size > 128) throw new Error("bigbud process registry exceeds monitor limit");
  return [...roots.values()];
}

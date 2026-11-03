import { app, type WebContents } from "electron";
import { join } from "node:path";
import type { SystemMonitorBridge } from "./system-monitor/bridge";
import { ResourceAwareness } from "./system-monitor/awareness";
import { registerSystemMonitorIpc } from "./system-monitor/ipc";
import {
  startSystemMonitorAgentBridge,
  stopSystemMonitorAgentBridge,
} from "./system-monitor/agentBridge";
import { registerResourceAwarenessIpc } from "./system-monitor/awareness.ipc";
let activeOwner: ResourceAwareness | undefined;

/** Composes one desktop-owned sampler with the trusted renderer and agent transports. */
export async function startDesktopResourceAwareness(
  bridge: SystemMonitorBridge,
  isMain: (sender: WebContents) => boolean,
): Promise<void> {
  registerSystemMonitorIpc(bridge, isMain);
  const owner = new ResourceAwareness(
    bridge,
    join(app.getPath("userData"), "system-monitor-preferences.json"),
  );
  activeOwner = owner;
  registerResourceAwarenessIpc(owner, isMain);
  await owner.start();
  if (activeOwner !== owner) return;
  await startSystemMonitorAgentBridge(owner);
}

export function stopDesktopResourceAwareness(): void {
  activeOwner?.stop();
  activeOwner = undefined;
  stopSystemMonitorAgentBridge();
}

import type { IpcMainInvokeEvent } from "electron";

import { desktopIpcChannels } from "../main.channels";
import type { DesktopWindowRegistry } from "./DesktopWindowRegistry";
import type { CompactScreenshotHandoff } from "./compactScreenshotHandoff";
import { authorizedHandle, type IpcRoles } from "./ipcAuthorization";

const COMPACT_ROLES: IpcRoles = ["compact-chat"];

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256;

export function registerCompactScreenshotIpc(
  registry: DesktopWindowRegistry,
  handoff: CompactScreenshotHandoff,
): void {
  const trusted = (event: IpcMainInvokeEvent) => {
    const window = registry.get("compact-chat");
    return window?.webContents === event.sender && event.senderFrame === event.sender.mainFrame;
  };
  authorizedHandle(
    desktopIpcChannels.getPendingCompactScreenshot,
    COMPACT_ROLES,
    (event, threadId: unknown) =>
      trusted(event) && validId(threadId) ? handoff.read(threadId) : null,
  );
  authorizedHandle(
    desktopIpcChannels.acknowledgeCompactScreenshot,
    COMPACT_ROLES,
    (event, captureId: unknown) =>
      trusted(event) && validId(captureId) ? handoff.acknowledge(captureId) : false,
  );
}

import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { desktopIpcChannels } from "../main.channels";
import type { DesktopWindowRegistry } from "./DesktopWindowRegistry";
import type { CompactScreenshotHandoff } from "./compactScreenshotHandoff";

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
  ipcMain.removeHandler(desktopIpcChannels.getPendingCompactScreenshot);
  ipcMain.handle(desktopIpcChannels.getPendingCompactScreenshot, (event, threadId: unknown) =>
    trusted(event) && validId(threadId) ? handoff.read(threadId) : null,
  );
  ipcMain.removeHandler(desktopIpcChannels.acknowledgeCompactScreenshot);
  ipcMain.handle(desktopIpcChannels.acknowledgeCompactScreenshot, (event, captureId: unknown) =>
    trusted(event) && validId(captureId) ? handoff.acknowledge(captureId) : false,
  );
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

import { desktopIpcChannels } from "../main.channels";
import { CompactScreenshotHandoff } from "./compactScreenshotHandoff";
import { DesktopWindowRegistry } from "./DesktopWindowRegistry";

const handlers = vi.hoisted(
  () => new Map<string, (event: IpcMainInvokeEvent, value: unknown) => unknown>(),
);
vi.mock("electron", () => ({
  ipcMain: {
    removeHandler: (name: string) => handlers.delete(name),
    handle: (name: string, handler: (event: IpcMainInvokeEvent, value: unknown) => unknown) =>
      handlers.set(name, handler),
  },
}));
import { registerCompactScreenshotIpc } from "./ipcHandlers.compactScreenshot";

describe("compact screenshot IPC", () => {
  beforeEach(() => handlers.clear());

  it("allows only the live compact main frame to read or acknowledge a bounded capture ID", () => {
    const registry = new DesktopWindowRegistry();
    const webContents = { id: 2, mainFrame: {} };
    registry.register("compact-chat", {
      webContents,
      once: vi.fn(),
      isDestroyed: () => false,
    } as unknown as BrowserWindow);
    const handoff = new CompactScreenshotHandoff();
    handoff.put({
      id: "capture",
      threadId: null,
      name: "image.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1,
      dataUrl: "data:image/jpeg;base64,AA==",
    });
    registerCompactScreenshotIpc(registry, handoff);
    const read = handlers.get(desktopIpcChannels.getPendingCompactScreenshot)!;
    const ack = handlers.get(desktopIpcChannels.acknowledgeCompactScreenshot)!;
    const trusted = {
      sender: webContents,
      senderFrame: webContents.mainFrame,
    } as IpcMainInvokeEvent;
    for (const event of [
      { sender: { id: 1, mainFrame: {} }, senderFrame: {} },
      { sender: webContents, senderFrame: {} },
    ]) {
      expect(read(event as IpcMainInvokeEvent, "thread")).toBeNull();
      expect(ack(event as IpcMainInvokeEvent, "capture")).toBe(false);
    }
    for (const invalid of [null, {}, "", " ", "x".repeat(257)]) {
      expect(read(trusted, invalid)).toBeNull();
      expect(ack(trusted, invalid)).toBe(false);
    }
    expect(read(trusted, "thread")).toMatchObject({ id: "capture", threadId: "thread" });
    expect(ack(trusted, "capture")).toBe(true);
    expect(read(trusted, "thread")).toBeNull();
  });
});

import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MACOS_SCREEN_RECORDING_SETTINGS_URL } from "@bigbud/shared/screenRecording";

import { DesktopWindowRegistry } from "./DesktopWindowRegistry";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  permission: vi.fn(),
  dialog: vi.fn(),
  openExternal: vi.fn(),
  delay: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
vi.mock("electron", () => ({
  screen: { getDisplayMatching: () => ({ id: 42 }) },
  dialog: { showMessageBox: mocks.dialog },
  shell: { openExternal: mocks.openExternal },
}));
vi.mock("./desktopScreenshot", () => ({
  captureDesktopScreenshot: mocks.capture,
  requireScreenRecordingPermission: mocks.permission,
  ScreenRecordingPermissionError: class extends Error {},
}));

import { ScreenRecordingPermissionError } from "./desktopScreenshot";
import { FloatingAssistantScreenshot } from "./floatingAssistantScreenshot";

function window(id: number, initiallyVisible: boolean, operations: string[]) {
  let visible = initiallyVisible;
  let destroyed = false;
  return {
    webContents: { id, send: vi.fn(() => operations.push("notify")) },
    once: vi.fn(),
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
    },
    getBounds: () => ({ x: -500, y: 100, width: 160, height: 160 }),
    hide: vi.fn(() => {
      visible = false;
      operations.push(`hide-${id}`);
    }),
    showInactive: vi.fn(() => {
      visible = true;
      operations.push(`restore-${id}`);
    }),
  };
}

function setup(chatVisible = true) {
  const operations: string[] = [];
  const registry = new DesktopWindowRegistry();
  const mascot = window(1, true, operations);
  const chat = window(2, chatVisible, operations);
  registry.register("mascot", mascot as unknown as BrowserWindow);
  registry.register("compact-chat", chat as unknown as BrowserWindow);
  const openChat = vi.fn(async () => {
    operations.push("open-chat");
    return chat as unknown as BrowserWindow;
  });
  const enabled = { value: true };
  const screenshots = new FloatingAssistantScreenshot({
    registry,
    isEnabled: () => enabled.value,
    openChat,
  });
  mocks.capture.mockImplementation(async () => {
    operations.push("capture");
    expect(mascot.isVisible()).toBe(false);
    expect(chat.isVisible()).toBe(false);
    return { mimeType: "image/jpeg", sizeBytes: 4, dataUrl: "data:image/jpeg;base64,anBlZw==" };
  });
  return { screenshots, operations, mascot, chat, openChat, enabled };
}

describe("floating screenshot action", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.delay.mockResolvedValue(undefined);
    mocks.dialog.mockResolvedValue({ response: 1 });
  });

  it("hides both floating windows before capture, restores them, then opens chat and notifies", async () => {
    const { screenshots, operations } = setup();
    screenshots.handoff.read("last-chat");
    await screenshots.request();
    expect(operations).toEqual([
      "hide-1",
      "hide-2",
      "capture",
      "restore-1",
      "restore-2",
      "open-chat",
      "notify",
    ]);
    expect(mocks.delay).toHaveBeenCalledWith(200);
    expect(mocks.capture).toHaveBeenCalledWith({ id: 42 });
    expect(screenshots.handoff.read("other-chat")).toMatchObject({
      threadId: "last-chat",
      sizeBytes: 4,
    });
  });

  it("does not briefly restore a chat that was initially hidden", async () => {
    const { screenshots, chat, openChat } = setup(false);
    await screenshots.request();
    expect(chat.hide).not.toHaveBeenCalled();
    expect(chat.showInactive).not.toHaveBeenCalled();
    expect(openChat).toHaveBeenCalledOnce();
  });

  it("reopens an unacknowledged screenshot without replacing it or capturing twice", async () => {
    const { screenshots, openChat } = setup();
    await screenshots.request();
    const first = screenshots.handoff.read("thread");
    await screenshots.request();
    expect(screenshots.handoff.read("thread")).toEqual(first);
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(openChat).toHaveBeenCalledTimes(2);
  });

  it("coalesces repeated clicks during capture", async () => {
    const { screenshots } = setup();
    let release!: (value: unknown) => void;
    mocks.delay.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = screenshots.request();
    await screenshots.request();
    release(undefined);
    await first;
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("restores windows before showing capture failure and permits retry", async () => {
    const { screenshots, mascot, chat } = setup();
    mocks.capture.mockRejectedValueOnce(new Error("capture failed"));
    mocks.dialog.mockImplementation(async () => {
      expect(mascot.isVisible()).toBe(true);
      expect(chat.isVisible()).toBe(true);
      return { response: 0 };
    });
    await screenshots.request();
    expect(screenshots.handoff.pending).toBe(false);
    expect(mocks.dialog).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "capture failed" }),
    );
    await screenshots.request();
    expect(screenshots.handoff.pending).toBe(true);
  });

  it("reuses the existing Screen Recording settings destination when permission is missing", async () => {
    const { screenshots, mascot } = setup();
    mocks.permission.mockImplementation(() => {
      throw new ScreenRecordingPermissionError();
    });
    mocks.dialog.mockResolvedValue({ response: 0 });
    await screenshots.request();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mascot.hide).not.toHaveBeenCalled();
    expect(mocks.openExternal).toHaveBeenCalledWith(MACOS_SCREEN_RECORDING_SETTINGS_URL);
  });

  it("drops an in-flight capture when disabled and does not reopen destroyed windows", async () => {
    const { screenshots, enabled, mascot, chat, openChat } = setup();
    let finish!: (value: unknown) => void;
    mocks.capture.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const request = screenshots.request();
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    screenshots.clear();
    enabled.value = false;
    mascot.destroy();
    chat.destroy();
    finish({ mimeType: "image/jpeg", sizeBytes: 4, dataUrl: "data:image/jpeg;base64,anBlZw==" });
    await request;
    expect(openChat).not.toHaveBeenCalled();
    expect(screenshots.handoff.pending).toBe(false);
    expect(mascot.showInactive).not.toHaveBeenCalled();
  });

  it("retains capture when opening the chat fails", async () => {
    const { screenshots, openChat } = setup();
    openChat.mockRejectedValueOnce(new Error("chat unavailable"));
    await screenshots.request();
    expect(screenshots.handoff.pending).toBe(true);
    await screenshots.request();
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(openChat).toHaveBeenCalledTimes(2);
  });
});

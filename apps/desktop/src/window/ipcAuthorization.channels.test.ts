import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every registered production IPC channel, driven with forged senders: the
 * restricted safety role, an unknown WebContents, a subframe, a stale
 * document (null senderFrame) and a destroyed sender. Each must deny with a
 * bounded value and cause no side effect (no dependency is called).
 */
type Listener = (event: unknown, ...args: unknown[]) => unknown;
const registered = vi.hoisted(() => ({
  handle: new Map<string, Listener>(),
  on: new Map<string, Listener>(),
}));
const fail = vi.hoisted(() => () => {
  throw new Error("electron side effect from a denied sender");
});
vi.mock("electron", () => {
  const ipcMain = {
    handle: (channel: string, fn: Listener) => registered.handle.set(channel, fn),
    removeHandler: (channel: string) => registered.handle.delete(channel),
    on: (channel: string, fn: Listener) => registered.on.set(channel, fn),
    removeAllListeners: (channel: string) => registered.on.delete(channel),
  };
  return {
    ipcMain,
    app: { on: vi.fn() },
    BrowserWindow: { fromWebContents: fail },
    clipboard: { writeText: fail },
    dialog: { showOpenDialog: fail },
    nativeTheme: { themeSource: "system" },
    shell: { openExternal: fail },
    Menu: { buildFromTemplate: fail },
    Notification: Object.assign(fail, { isSupported: fail }),
  };
});

import { desktopIpcChannels } from "../main.channels";
import { registerFloatingAssistantIpc } from "../main.floatingAssistant";
import { registerTerminalRenderingIpc } from "../main.terminalRendering";
import { registerSystemMonitorIpc } from "../system-monitor/ipc";
import { COMPUTER_USE_SAFETY_ROLE } from "./DesktopWindowRegistry";
import { registerIpcHandlers } from "./ipcHandlers";
import { registerOwnershipRecoveryIpc } from "./ipcHandlers.ownershipRecovery";
import { authorizeFakeSenders, fakeIpcSender } from "./ipcAuthorization.testSupport";

const sideEffect = vi.fn(() => {
  throw new Error("dependency called for a denied sender");
});
/** Any dependency access returns the side-effect detector. */
const detector = new Proxy({}, { get: () => sideEffect }) as never;

function registerEverything(): void {
  const channelDeps = Object.fromEntries(
    Object.keys(desktopIpcChannels).map((key) => [key, (desktopIpcChannels as never)[key]]),
  );
  registerIpcHandlers(
    new Proxy(
      {},
      {
        get: (_target, key: string) =>
          key.endsWith("_CHANNEL")
            ? `channel:${key}`
            : key === "isTrustedRenderer"
              ? () => true
              : sideEffect,
      },
    ) as never,
  );
  registerSystemMonitorIpc(detector, () => true);
  registerTerminalRenderingIpc(() => true);
  registerOwnershipRecoveryIpc(() => undefined, Object.assign(sideEffect, { check: sideEffect }));
  registerFloatingAssistantIpc({
    appQuitActions: detector,
    channels: channelDeps as never,
    desktopPreferences: detector,
    floatingAssistantWindows: { screenshots: { handoff: detector } } as never,
    openMainWindow: sideEffect,
    windowRegistry: { getRole: sideEffect, get: sideEffect, isTrusted: sideEffect } as never,
  });
}

const safety = fakeIpcSender(1);
const legit = fakeIpcSender(2);
const forged = {
  "safety role": { sender: safety, senderFrame: safety.mainFrame },
  "unknown sender": { sender: fakeIpcSender(3), senderFrame: {} },
  subframe: { sender: legit, senderFrame: {} },
  "stale document": { sender: legit, senderFrame: null },
  "destroyed sender": {
    sender: fakeIpcSender(4, { isDestroyed: () => true }),
    senderFrame: null,
  },
} as const;

describe("every-handler IPC authorization", () => {
  beforeEach(() => {
    registered.handle.clear();
    registered.on.clear();
    sideEffect.mockClear();
    authorizeFakeSenders([
      [safety, COMPUTER_USE_SAFETY_ROLE],
      [legit, "main"],
    ]);
    registerEverything();
  });

  it("registers the audited production channel set", () => {
    // Includes the window-material snapshot and floating-assistant helper channels.
    expect(registered.handle.size).toBe(50);
    expect(registered.on.size).toBe(4);
    for (const credentialOrEffect of [
      "channel:GET_WS_URL_CHANNEL",
      "channel:GET_MOBILE_BACKEND_BASE_URL_CHANNEL",
      "channel:REQUEST_COMPUTER_USE_PERMISSIONS_CHANNEL",
      "channel:INSTALL_COMPUTER_USE_RUNTIME_CHANNEL",
      "channel:RUN_COMPUTER_USE_DOCTOR_CHANNEL",
      "channel:ENABLE_TAILSCALE_REMOTE_ACCESS_CHANNEL",
      "channel:UPDATE_INSTALL_CHANNEL",
      "desktop:quit-application",
    ]) {
      expect(
        registered.handle.has(credentialOrEffect) || registered.on.has(credentialOrEffect),
        credentialOrEffect,
      ).toBe(true);
    }
  });

  for (const [name, event] of Object.entries(forged)) {
    it(`denies every channel for a ${name} without side effects`, async () => {
      for (const [channel, listener] of registered.handle) {
        expect(await listener(event, "arg", { x: 1 }), channel).toBeNull();
      }
      for (const [channel, listener] of registered.on) {
        const syncEvent = { ...event, returnValue: "unset" as unknown };
        listener(syncEvent, "arg");
        expect(syncEvent.returnValue, channel).toBeNull();
      }
      expect(sideEffect).not.toHaveBeenCalled();
    });
  }

  it("denies a main-window sender on the mascot-only Stop computer use channel", async () => {
    const listener = registered.handle.get(desktopIpcChannels.setMascotComputerUseActive)!;
    expect(await listener({ sender: legit, senderFrame: legit.mainFrame }, true)).toBeNull();
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("still reaches the handler for a registered broad renderer's main frame", () => {
    const listener = registered.on.get("channel:GET_WS_URL_CHANNEL")!;
    const event = { sender: legit, senderFrame: legit.mainFrame, returnValue: undefined };
    expect(() => listener(event)).toThrow("dependency called");
  });
});

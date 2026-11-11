import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  fromWebContents: vi.fn(),
  apply: vi.fn(),
  getState: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { on: vi.fn() },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  ipcMain: {
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
    handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
  },
  clipboard: {},
  dialog: {},
  nativeTheme: {},
  shell: {},
}));
vi.mock("./windowManager.material", () => ({
  applyWindowMaterial: mocks.apply,
  getWindowMaterialState: mocks.getState,
}));
vi.mock("./menuManager", () => ({ getSafeExternalUrl: vi.fn() }));

import { desktopIpcChannels } from "../main.channels";
import { registerIpcHandlers } from "./ipcHandlers";
import { authorizeFakeSenders, fakeIpcSender } from "./ipcAuthorization.testSupport";

describe("window material IPC", () => {
  const sender = fakeIpcSender(10);
  const event = { sender, senderFrame: sender.mainFrame };
  const ownWindow = {};

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    authorizeFakeSenders([[sender, "main"]]);
    mocks.fromWebContents.mockReturnValue(ownWindow);
    mocks.getState.mockReturnValue({ mode: "automatic", material: "solid" });
    registerIpcHandlers(
      new Proxy(
        {},
        {
          get: (_target, key: string) => (key.endsWith("_CHANNEL") ? key : vi.fn()),
        },
      ) as never,
    );
  });

  it("returns the calling window's applied state without falling back to another window", async () => {
    const get = mocks.handlers.get(desktopIpcChannels.getWindowMaterialState)!;
    expect(await get(event)).toEqual({ mode: "automatic", material: "solid" });
    expect(mocks.getState).toHaveBeenCalledWith(ownWindow);
    mocks.fromWebContents.mockReturnValue(null);
    expect(await get(event)).toBeNull();
    expect(mocks.getState).toHaveBeenCalledOnce();
  });

  it("applies valid saved preferences and rejects invalid ones", async () => {
    const set = mocks.handlers.get("SET_WINDOW_MATERIAL_CHANNEL")!;
    await set(event, "automatic");
    await set(event, "translucent");
    await set(event, "solid");
    await set(event, "glass");
    expect(mocks.apply.mock.calls).toEqual([
      [ownWindow, "automatic", undefined],
      [ownWindow, "translucent", undefined],
      [ownWindow, "solid", undefined],
    ]);
  });

  it("validates and forwards selection IDs", async () => {
    const set = mocks.handlers.get("SET_WINDOW_MATERIAL_CHANNEL")!;
    await set(event, "automatic", "selection-id");
    for (const requestId of [null, 1, {}, "", "x".repeat(129)])
      await set(event, "automatic", requestId);
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(ownWindow, "automatic", "selection-id");
  });
});

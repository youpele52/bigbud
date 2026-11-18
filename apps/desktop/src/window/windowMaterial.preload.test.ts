import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: ipc }));

import { desktopIpcChannels } from "../main.channels";
import { windowMaterialBridge } from "./windowMaterial.preload";

describe("window material preload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the initial state through the authorized snapshot channel", async () => {
    const state = { mode: "automatic", material: "translucent" };
    ipc.invoke.mockResolvedValue(state);
    expect(await windowMaterialBridge.getWindowMaterialState()).toEqual(state);
    expect(ipc.invoke).toHaveBeenCalledWith(desktopIpcChannels.getWindowMaterialState);
  });

  it.each([
    null,
    {},
    { mode: "glass", material: "solid" },
    { mode: "automatic", material: "glass" },
    { mode: "automatic", material: "solid", requestId: 12 },
  ])("rejects invalid snapshots %o", async (value) => {
    ipc.invoke.mockResolvedValue(value);
    expect(await windowMaterialBridge.getWindowMaterialState()).toBeNull();
  });

  it("validates events, strips their Electron event argument, and removes the listener", () => {
    const listener = vi.fn();
    const stop = windowMaterialBridge.onWindowMaterialState(listener);
    const handler = ipc.on.mock.calls[0]![1] as (event: unknown, state: unknown) => void;
    handler({}, { mode: "automatic", material: "solid", requestId: "selection-id" });
    handler({}, { mode: "automatic", material: "glass" });
    handler({}, null);
    expect(listener.mock.calls).toEqual([
      [{ mode: "automatic", material: "solid", requestId: "selection-id" }],
    ]);
    stop();
    expect(ipc.removeListener).toHaveBeenCalledWith(
      desktopIpcChannels.windowMaterialState,
      handler,
    );
  });
});

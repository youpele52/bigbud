import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const theme = vi.hoisted(() => ({
  shouldUseDarkColors: false,
  prefersReducedTransparency: false,
  shouldUseHighContrastColors: false,
  on: vi.fn(),
  off: vi.fn(),
}));
vi.mock("electron", () => ({ nativeTheme: theme }));

import { desktopIpcChannels } from "../main.channels";
import {
  applyWindowMaterial,
  bindWindowMaterial,
  getWindowMaterialState,
} from "./windowManager.material";

function createWindow() {
  return Object.assign(new EventEmitter(), {
    setVibrancy: vi.fn(),
    setBackgroundColor: vi.fn(),
    webContents: { send: vi.fn() },
  });
}
type TestWindow = ReturnType<typeof createWindow>;
const asWindow = (window: TestWindow) => window as unknown as BrowserWindow;

describe("window material lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("process", { ...process, platform: "darwin", getSystemVersion: () => "26.1" });
    theme.shouldUseDarkColors = false;
    theme.prefersReducedTransparency = false;
    theme.shouldUseHighContrastColors = false;
    theme.on.mockClear();
    theme.off.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stays solid until the renderer provides its persisted setting", () => {
    const window = createWindow();
    bindWindowMaterial(asWindow(window));
    expect(getWindowMaterialState(asWindow(window))).toEqual({ mode: "solid", material: "solid" });
    expect(window.setVibrancy).not.toHaveBeenCalled();
  });

  it("applies native material before publishing the matching renderer state", () => {
    const window = createWindow();
    applyWindowMaterial(asWindow(window), "automatic");
    expect(window.setVibrancy).toHaveBeenCalledWith("sidebar");
    expect(window.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(window.webContents.send).toHaveBeenCalledWith(desktopIpcChannels.windowMaterialState, {
      mode: "automatic",
      material: "translucent",
    });
    expect(window.setBackgroundColor.mock.invocationCallOrder[0]).toBeLessThan(
      window.webContents.send.mock.invocationCallOrder[0]!,
    );
  });

  it("responds to live accessibility changes without replacing Automatic", () => {
    const window = createWindow();
    bindWindowMaterial(asWindow(window));
    applyWindowMaterial(asWindow(window), "automatic", "selection-id");
    const sync = theme.on.mock.calls[0]![1] as () => void;
    theme.prefersReducedTransparency = true;
    theme.shouldUseDarkColors = true;
    sync();
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#0a0a0a");
    expect(getWindowMaterialState(asWindow(window))).toEqual({
      mode: "automatic",
      material: "solid",
      requestId: "selection-id",
    });
    theme.prefersReducedTransparency = false;
    sync();
    expect(getWindowMaterialState(asWindow(window)).material).toBe("translucent");
    theme.shouldUseHighContrastColors = true;
    sync();
    expect(getWindowMaterialState(asWindow(window)).material).toBe("solid");
  });

  it("keeps manual choices and windows independent across system updates", () => {
    const solid = createWindow();
    const translucent = createWindow();
    for (const window of [solid, translucent]) bindWindowMaterial(asWindow(window));
    applyWindowMaterial(asWindow(solid), "solid");
    applyWindowMaterial(asWindow(translucent), "translucent");
    expect(theme.on).toHaveBeenCalledTimes(2);
    theme.prefersReducedTransparency = true;
    for (const [, sync] of theme.on.mock.calls) (sync as () => void)();
    expect(getWindowMaterialState(asWindow(solid))).toEqual({ mode: "solid", material: "solid" });
    expect(getWindowMaterialState(asWindow(translucent))).toEqual({
      mode: "translucent",
      material: "translucent",
    });
  });

  it("removes its theme listener and state when a window closes", () => {
    const window = createWindow();
    bindWindowMaterial(asWindow(window));
    applyWindowMaterial(asWindow(window), "automatic");
    window.emit("closed");
    expect(theme.off).toHaveBeenCalledWith("updated", theme.on.mock.calls[0]![1]);
    expect(getWindowMaterialState(asWindow(window)).material).toBe("solid");
  });
});

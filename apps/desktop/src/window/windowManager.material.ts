import { nativeTheme, type BrowserWindow } from "electron";
import type { DesktopWindowMaterial } from "@bigbud/contracts/core/settings.ts";
import type { DesktopWindowMaterialState } from "@bigbud/contracts/server/ipc.windowMaterial.ts";
import { desktopIpcChannels } from "../main.channels";
import { resolveWindowMaterial } from "./windowMaterial.logic";

const windowMaterials = new WeakMap<BrowserWindow, DesktopWindowMaterialState>();
const boundWindows = new WeakSet<BrowserWindow>();

export function getOpaqueBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

export function getWindowMaterialState(window: BrowserWindow): DesktopWindowMaterialState {
  // Stay opaque until the renderer supplies its persisted preference.
  return windowMaterials.get(window) ?? { mode: "solid", material: "solid" };
}

export function applyWindowMaterial(
  window: BrowserWindow,
  mode: DesktopWindowMaterial,
  requestId?: string,
): void {
  bindWindowMaterial(window);
  const material = resolveWindowMaterial(mode, {
    platform: process.platform,
    systemVersion: process.platform === "darwin" ? process.getSystemVersion() : "",
    reducedTransparency: nativeTheme.prefersReducedTransparency,
    highContrast: nativeTheme.shouldUseHighContrastColors,
  });

  if (process.platform === "darwin") {
    window.setVibrancy(material === "translucent" ? "sidebar" : null);
  }
  window.setBackgroundColor(material === "translucent" ? "#00000000" : getOpaqueBackgroundColor());
  const state = { mode, material, ...(requestId === undefined ? {} : { requestId }) };
  windowMaterials.set(window, state);
  window.webContents.send(desktopIpcChannels.windowMaterialState, state);
}

export function bindWindowMaterial(window: BrowserWindow): void {
  if (boundWindows.has(window)) return;
  boundWindows.add(window);
  const sync = () => {
    const state = getWindowMaterialState(window);
    applyWindowMaterial(window, state.mode, state.requestId);
  };
  nativeTheme.on("updated", sync);
  window.on("closed", () => {
    nativeTheme.off("updated", sync);
    windowMaterials.delete(window);
    boundWindows.delete(window);
  });
}

import { ipcRenderer } from "electron";
import type { DesktopWindowMaterialState } from "@bigbud/contracts/server/ipc.windowMaterial.ts";
import { desktopIpcChannels } from "../main.channels";
import { getSafeWindowMaterial, isWindowMaterialRequestId } from "./windowMaterial.logic";

function isWindowMaterialState(value: unknown): value is DesktopWindowMaterialState {
  return (
    typeof value === "object" &&
    value !== null &&
    "mode" in value &&
    getSafeWindowMaterial(value.mode) !== null &&
    "material" in value &&
    (value.material === "solid" || value.material === "translucent") &&
    (!("requestId" in value) || isWindowMaterialRequestId(value.requestId))
  );
}

export const windowMaterialBridge = {
  getWindowMaterialState: async (): Promise<DesktopWindowMaterialState | null> => {
    const state: unknown = await ipcRenderer.invoke(desktopIpcChannels.getWindowMaterialState);
    return isWindowMaterialState(state) ? state : null;
  },
  onWindowMaterialState: (listener: (state: DesktopWindowMaterialState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (isWindowMaterialState(state)) listener(state);
    };
    ipcRenderer.on(desktopIpcChannels.windowMaterialState, handler);
    return () => ipcRenderer.removeListener(desktopIpcChannels.windowMaterialState, handler);
  },
};

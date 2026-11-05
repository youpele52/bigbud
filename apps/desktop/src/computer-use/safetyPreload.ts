import { contextBridge, ipcRenderer } from "electron";

import { computerUseSafetyChannels } from "./safetyWindow.channels";

// Restricted safety preload: fixed channels only, no generic invoke/send, no
// backend credentials, permissions, installer, settings writes or Resume.
contextBridge.exposeInMainWorld("bigbudComputerUseSafety", {
  getStatus: () => ipcRenderer.invoke(computerUseSafetyChannels.getStatus),
  stop: () => ipcRenderer.invoke(computerUseSafetyChannels.stop),
  acknowledgeWarning: (noticeId: string) =>
    ipcRenderer.invoke(computerUseSafetyChannels.acknowledgeWarning, noticeId),
  openRestrictions: () => ipcRenderer.invoke(computerUseSafetyChannels.openRestrictions),
});

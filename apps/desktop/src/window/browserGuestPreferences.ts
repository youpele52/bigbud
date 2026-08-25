import type { WebPreferences } from "electron";

/** Applies the minimum privilege boundary required for remote browser guests. */
export function hardenBrowserGuestPreferences(webPreferences: WebPreferences): void {
  delete webPreferences.preload;
  webPreferences.contextIsolation = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.sandbox = true;
  webPreferences.webviewTag = false;
}

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
  // Guests default to a transparent base background, so pages that never paint one showed the
  // app panel behind them. Opaque guests paint their own canvas from the page's color scheme,
  // matching a normal browser tab regardless of app theme, OS appearance or window material.
  webPreferences.transparent = false;
}

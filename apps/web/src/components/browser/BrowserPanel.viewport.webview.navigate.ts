import type { ElectronWebview } from "./BrowserPanel.viewport.types";
import { isWebviewReady } from "./BrowserPanel.viewport.webview.utils";

const ABORTED_WEBVIEW_LOAD = /ERR_ABORTED|\(-3\)/;

export function isAbortedWebviewNavigation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ABORTED_WEBVIEW_LOAD.test(message);
}

export function webviewIsShowingUrl(webview: ElectronWebview, url: string): boolean {
  if (url.length === 0) return true;
  if (webview.getAttribute("src") === url) return true;
  if (!isWebviewReady(webview)) return false;
  try {
    return webview.getURL() === url;
  } catch {
    return false;
  }
}

export function navigateElectronWebview(webview: ElectronWebview, url: string): void {
  if (url.length === 0 || webviewIsShowingUrl(webview, url)) return;

  if (isWebviewReady(webview) && typeof webview.loadURL === "function") {
    void webview.loadURL(url).catch((error: unknown) => {
      if (isAbortedWebviewNavigation(error)) return;
      console.error("Failed to load browser URL:", error);
    });
    return;
  }

  try {
    webview.setAttribute("src", url);
  } catch {
    // Guest frame may still be attaching.
  }
}

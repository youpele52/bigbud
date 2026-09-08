import type { ElectronWebview } from "./BrowserPanel.viewport.types";

export const BROWSER_WEBVIEW_PARTITION = "persist:bigbud-browser";

export function assignBrowserWebviewPartition(webview: ElectronWebview): void {
  webview.setAttribute("partition", BROWSER_WEBVIEW_PARTITION);
}

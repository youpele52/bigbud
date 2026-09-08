import { BrowserPanelErrorPage } from "./BrowserPanel.errorPage";
import type { BrowserWebviewState } from "./BrowserPanel.viewport";

const webviewStateContent = {
  crashed: {
    title: "This browser tab crashed",
    description: "The page's renderer stopped unexpectedly.",
    suggestions: ["Reloading the page", "Opening the page in your default browser"],
    technicalCode: "WEBVIEW_CRASHED",
  },
  unresponsive: {
    title: "This browser tab is unresponsive",
    description: "The page isn't responding right now.",
    suggestions: ["Reloading the page", "Waiting a moment before trying again"],
    technicalCode: "WEBVIEW_UNRESPONSIVE",
  },
} satisfies Record<BrowserWebviewState, Parameters<typeof BrowserPanelErrorPage>[0]["content"]>;

export function BrowserPanelWebviewStateErrorPage({
  state,
  onReload,
}: {
  state: BrowserWebviewState | null;
  onReload: () => void;
}) {
  if (!state) return null;

  return <BrowserPanelErrorPage content={webviewStateContent[state]} onReload={onReload} />;
}

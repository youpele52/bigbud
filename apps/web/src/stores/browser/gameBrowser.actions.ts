import { toastManager } from "~/components/ui/toast";
import { requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import {
  countRightPanelTabsByKind,
  MAX_RIGHT_PANEL_BROWSER_TABS,
  useRightPanelTabsStore,
} from "../rightPanel/rightPanelTabs.store";
import { useBrowserPanelStore } from "./browser.store";
import { closeBrowserTab } from "./browserPanel.actions";

let launching = false;
let pending: { name: string; url: string; onOpened: () => void } | null = null;

/** Opens only a fresh tab; never overwrites or revokes an agent-controlled tab. */
export function openGameBrowserTab(input: {
  name: string;
  url: string;
  onOpened: () => void;
}): boolean {
  if (launching) return false;
  launching = true;
  try {
    const tabs = useRightPanelTabsStore.getState();
    const browser = useBrowserPanelStore.getState();
    let evictedName: string | null = null;
    if (countRightPanelTabsByKind(tabs.openTabs, "browser") >= MAX_RIGHT_PANEL_BROWSER_TABS) {
      const oldest = tabs.browserCreationOrder.find((id) => tabs.openTabs.includes(id));
      if (!oldest || browser.tabsById[oldest]?.agentLease) {
        pending = input;
        toastManager.add({
          type: "warning",
          title: `Maximum of ${MAX_RIGHT_PANEL_BROWSER_TABS} browser tabs`,
          description: oldest
            ? "The oldest tab is agent-controlled. Close a browser tab manually, then retry."
            : "Close a browser tab manually, then retry.",
          actionProps: { children: "Retry", onClick: () => retryPendingGame() },
        });
        return false;
      }
      evictedName =
        browser.tabsById[oldest]?.title || browser.tabsById[oldest]?.url || "the oldest tab";
      closeBrowserTab(oldest);
      if (useRightPanelTabsStore.getState().openTabs.includes(oldest)) {
        pending = input;
        toastManager.add({
          type: "warning",
          title: "Could not close the oldest tab",
          description: "Close a browser tab manually, then retry.",
          actionProps: { children: "Retry", onClick: () => retryPendingGame() },
        });
        return false;
      }
    }
    const result = useRightPanelTabsStore.getState().openBrowserTab();
    if (result.status !== "created" || !result.tabId) {
      pending = input;
      toastManager.add({
        type: "error",
        title: "Could not open game tab",
        description: "Close a browser tab and retry.",
        actionProps: { children: "Retry", onClick: () => retryPendingGame() },
      });
      return false;
    }
    browser.ensureTab(result.tabId, input.url);
    useRightPanelTabsStore.getState().setGamesWidthTabId(result.tabId);
    requestRightPanel("browser");
    useBrowserPanelStore.getState().setOpen(true);
    pending = null;
    if (evictedName)
      toastManager.add({
        type: "info",
        title: `Closed ${evictedName} to make room for ${input.name}`,
      });
    input.onOpened();
    return true;
  } catch (error) {
    pending = input;
    toastManager.add({
      type: "error",
      title: "Could not launch game",
      description: String(error),
      actionProps: { children: "Retry", onClick: () => retryPendingGame() },
    });
    return false;
  } finally {
    launching = false;
  }
}

function retryPendingGame(): void {
  if (pending) openGameBrowserTab(pending);
}

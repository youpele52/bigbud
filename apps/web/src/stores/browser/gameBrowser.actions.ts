import { toastManager } from "~/components/ui/toast";
import { getBrowserTabLimit } from "~/hooks/useSettings.storage";
import { requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { selectOpenBrowserTabs, useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useBrowserPanelStore } from "./browser.store";
import {
  type BrowserClosePlan,
  useBrowserCloseConfirmationStore,
} from "./browserCloseConfirmation.store";
import { closeBrowserTabsAfterRevocation } from "./browserPanel.actions";
import {
  getBrowserTabName,
  isBrowserTabLeased,
  planBrowserTabReplacements,
} from "./browserTabCapacity";

let launching = false;
interface GameLaunch {
  name: string;
  url: string;
  onOpened: () => void;
}
let pending: GameLaunch | null = null;

/** Opens only a fresh tab; never overwrites or revokes an agent-controlled tab. */
export function openGameBrowserTab(input: GameLaunch): boolean {
  return launchGameBrowserTab(input);
}

function launchGameBrowserTab(input: GameLaunch, approved?: BrowserClosePlan): boolean {
  if (launching) return false;
  launching = true;
  try {
    const browser = useBrowserPanelStore.getState();
    const limit = approved?.limit ?? getBrowserTabLimit();
    const { tabIds, unknownOrder } = approved
      ? { tabIds: approved.tabIds, unknownOrder: false }
      : planBrowserTabReplacements(limit, "game");
    if (tabIds.some(isBrowserTabLeased)) {
      offerGameLeaseRetry(input, limit);
      return false;
    }
    if (unknownOrder) {
      useBrowserCloseConfirmationStore.getState().request({
        kind: "overflow",
        tabIds,
        unknownOrder,
        continuation: {
          kind: "game",
          resume: (plan) => launchGameBrowserTab(input, plan),
          onLeaseConflict: (limit) => offerGameLeaseRetry(input, limit),
        },
      });
      return false;
    }

    const evictedNames = tabIds.map((id) => getBrowserTabName(browser.tabsById[id]));
    closeBrowserTabsAfterRevocation(tabIds);
    const result = useRightPanelTabsStore.getState().openBrowserTab(limit);
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
    if (evictedNames.length > 0)
      toastManager.add({
        type: "info",
        title: `Closed ${evictedNames.join(", ")} to make room for ${input.name}`,
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

function offerGameLeaseRetry(input: GameLaunch, limit: number): void {
  pending = input;
  toastManager.add({
    type: "warning",
    title: `Maximum of ${limit} browser tabs`,
    description:
      "A tab that needs replacing is agent-controlled. Close browser tabs manually, then retry.",
    actionProps: { children: "Retry", onClick: () => retryPendingGame() },
  });
}

function retryPendingGame(): void {
  if (!pending) return;
  const limit = getBrowserTabLimit();
  const needed = selectOpenBrowserTabs(useRightPanelTabsStore.getState()).length - limit + 1;
  if (needed <= 0) {
    launchGameBrowserTab(pending, { limit, tabIds: [] });
    return;
  }
  toastManager.add({
    type: "warning",
    title: `Maximum of ${limit} browser tabs`,
    description: `Close ${needed} browser ${needed === 1 ? "tab" : "tabs"} manually, then retry.`,
    actionProps: { children: "Retry", onClick: () => retryPendingGame() },
  });
}

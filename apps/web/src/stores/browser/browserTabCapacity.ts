import { selectOpenBrowserTabs, useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useBrowserPanelStore } from "./browser.store";

/** Plans enough replacements for one new tab without mistaking UI order for opening order. */
export function planBrowserTabReplacements(limit: number, mode: "browser" | "game" = "browser") {
  const state = useRightPanelTabsStore.getState();
  const { browserCreationOrder } = state;
  const browserTabs = selectOpenBrowserTabs(state);
  const needed = browserTabs.length - limit + 1;
  if (needed <= 0) return { tabIds: [], unknownOrder: false };

  const open = new Set(browserTabs);
  const ordered = new Set(browserCreationOrder.filter((tabId) => open.has(tabId)));
  // A tab without a record could be older than every recorded tab. Only use UI order
  // to pick candidates among these ambiguous tabs, and report that they're guesses.
  const unknown = browserTabs.filter((tabId) => !ordered.has(tabId));
  const candidates = [...unknown, ...ordered];
  if (mode === "game" && unknown.length > 0) {
    // Games can propose other tabs when opening order is unknown without revoking control.
    const unleased = candidates.filter((tabId) => !isBrowserTabLeased(tabId));
    if (unleased.length >= needed) return { tabIds: unleased.slice(0, needed), unknownOrder: true };
  }
  return {
    tabIds: candidates.slice(0, needed),
    unknownOrder: unknown.length > 0,
  };
}

export function getBrowserTabName(
  tab: { readonly title: string; readonly url: string } | undefined,
) {
  return tab?.title.trim() || tab?.url.trim() || "Untitled browser tab";
}

export function isBrowserTabLeased(tabId: string): boolean {
  return Boolean(useBrowserPanelStore.getState().tabsById[tabId]?.agentLease);
}

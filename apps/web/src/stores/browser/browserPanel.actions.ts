import { toastManager } from "~/components/ui/toast";
import { requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import {
  countRightPanelTabsByKind,
  isRightPanelTabOfKind,
  MAX_RIGHT_PANEL_BROWSER_TABS,
  selectLastRightPanelTabIdByKind,
  type RightPanelTabId,
  useRightPanelTabsStore,
} from "../rightPanel/rightPanelTabs.store";
import { useBrowserPanelStore } from "./browser.store";
import { useBrowserCloseConfirmationStore } from "./browserCloseConfirmation.store";

export function openBrowserPanel(input: { url?: string } = {}) {
  const nextUrl = input.url?.trim();
  const browserStore = useBrowserPanelStore.getState();
  const tabState = useRightPanelTabsStore.getState();
  const activeBrowserTabId =
    tabState.activeTabId && isRightPanelTabOfKind(tabState.activeTabId, "browser")
      ? tabState.activeTabId
      : null;
  const browserTabId =
    activeBrowserTabId ?? selectLastRightPanelTabIdByKind(tabState.openTabs, "browser");

  if (browserTabId) {
    if (nextUrl) {
      browserStore.setTabUrl(browserTabId, nextUrl);
    }

    requestRightPanel("browser");
    useRightPanelTabsStore.getState().setActiveTab(browserTabId);
    browserStore.setOpen(true);
    return;
  }

  const result = useRightPanelTabsStore.getState().openBrowserTab();
  if (!result.tabId) {
    return;
  }

  browserStore.ensureTab(result.tabId, nextUrl ?? "");
  requestRightPanel("browser");
  browserStore.setOpen(true);
}

export function openNewBrowserTab(input: { url?: string } = {}) {
  const nextUrl = input.url?.trim();
  const browserStore = useBrowserPanelStore.getState();
  const result = useRightPanelTabsStore.getState().openBrowserTab();

  if (result.status === "limit_reached") {
    toastManager.add({
      type: "error",
      title: `Maximum of ${MAX_RIGHT_PANEL_BROWSER_TABS} browser tabs`,
    });
    return;
  }

  if (!result.tabId) {
    return;
  }

  browserStore.ensureTab(result.tabId, nextUrl ?? "");
  requestRightPanel("browser");
  browserStore.setOpen(true);
}

export function toggleBrowserPanel() {
  const tabState = useRightPanelTabsStore.getState();
  const browserOpen = useBrowserPanelStore.getState().open;
  const browserActive = tabState.activeKind === "browser" && tabState.rightPanelOpen;
  const lastBrowserTabId = selectLastRightPanelTabIdByKind(tabState.openTabs, "browser");

  if (!browserOpen || !browserActive) {
    if (lastBrowserTabId) {
      requestRightPanel("browser");
      useRightPanelTabsStore.getState().setActiveTab(lastBrowserTabId);
      useBrowserPanelStore.getState().setOpen(true);
      return;
    }

    openBrowserPanel();
    return;
  }

  closeActiveBrowserTab();
}

export function closeBrowserPanel() {
  const tabState = useRightPanelTabsStore.getState();
  const browserTabIds = tabState.openTabs.filter((tabId) =>
    isRightPanelTabOfKind(tabId, "browser"),
  );
  if (browserTabIds.some((tabId) => useBrowserPanelStore.getState().tabsById[tabId]?.agentLease)) {
    useBrowserCloseConfirmationStore.getState().request(browserTabIds);
    return;
  }

  useRightPanelTabsStore.getState().closeTab("browser");
  requestRightPanel(useRightPanelTabsStore.getState().activeKind);
  useBrowserPanelStore.getState().removeTabs(browserTabIds);
  useBrowserPanelStore.getState().setOpen(false);
}

export function closeBrowserTab(tabId: RightPanelTabId) {
  if (useBrowserPanelStore.getState().tabsById[tabId]?.agentLease) {
    useBrowserCloseConfirmationStore.getState().request([tabId]);
    return;
  }
  closeBrowserTabImmediately(tabId);
}

export function closeBrowserTabsAfterRevocation(tabIds: ReadonlyArray<RightPanelTabId>) {
  for (const tabId of tabIds) {
    closeBrowserTabImmediately(tabId);
  }
}

function closeBrowserTabImmediately(tabId: RightPanelTabId) {
  const browserCount = countRightPanelTabsByKind(
    useRightPanelTabsStore.getState().openTabs,
    "browser",
  );

  useRightPanelTabsStore.getState().closeTabById(tabId);
  requestRightPanel(useRightPanelTabsStore.getState().activeKind);
  useBrowserPanelStore.getState().removeTab(tabId);
  useBrowserPanelStore.getState().setOpen(browserCount > 1);
}

function closeActiveBrowserTab() {
  const activeTabId = useRightPanelTabsStore.getState().activeTabId;
  if (!activeTabId || !isRightPanelTabOfKind(activeTabId, "browser")) {
    return;
  }

  closeBrowserTab(activeTabId);
}

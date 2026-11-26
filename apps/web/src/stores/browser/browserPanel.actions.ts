import { getBrowserTabLimit } from "~/hooks/useSettings.storage";
import { matchesBrowserUrl } from "~/lib/browserUrl";
import { requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import {
  countRightPanelTabsByKind,
  isRightPanelTabOfKind,
  selectLastRightPanelTabIdByKind,
  type RightPanelTabId,
  useRightPanelTabsStore,
} from "../rightPanel/rightPanelTabs.store";
import { useBrowserPanelStore } from "./browser.store";
import {
  type BrowserClosePlan,
  type BrowserCloseRequest,
  useBrowserCloseConfirmationStore,
} from "./browserCloseConfirmation.store";
import { isBrowserTabLeased, planBrowserTabReplacements } from "./browserTabCapacity";

export function openBrowserPanel(input: { url?: string } = {}) {
  const nextUrl = input.url?.trim() ?? "";
  const browserStore = useBrowserPanelStore.getState();
  const tabState = useRightPanelTabsStore.getState();
  if (nextUrl && tabState.activeTabId && tabState.activeTabId === tabState.browserDraftTabId) {
    resolveBrowserTabNavigation(tabState.activeTabId, nextUrl);
    return;
  }
  if (activateBrowserTabWithUrl(nextUrl)) return;
  const activeBrowserTabId =
    tabState.activeTabId && isRightPanelTabOfKind(tabState.activeTabId, "browser")
      ? tabState.activeTabId
      : null;
  const browserTabId =
    activeBrowserTabId ?? selectLastRightPanelTabIdByKind(tabState.openTabs, "browser");

  if (browserTabId) {
    if (nextUrl) {
      if (browserTabId === tabState.browserDraftTabId) {
        openBrowserPage(nextUrl, browserTabId);
        return;
      }
      if (isBrowserTabLeased(browserTabId)) {
        openBrowserPage(nextUrl);
        return;
      }
      browserStore.setTabUrl(browserTabId, nextUrl);
    }

    activateBrowserTab(browserTabId);
    return;
  }

  openNewBrowserTab({ url: nextUrl });
}

export function openNewBrowserTab(input: { url?: string } = {}) {
  const url = input.url?.trim() ?? "";
  if (activateBrowserTabWithUrl(url)) return;
  openBrowserPage(url);
}

function openBrowserPage(url: string, draftTabId?: RightPanelTabId) {
  const limit = getBrowserTabLimit();
  const plan = planBrowserTabReplacements(limit);
  if (!url) {
    // Wait for an address before evicting a page the user might be trying to reopen.
    const draft =
      plan.tabIds.length > 0 || Boolean(useRightPanelTabsStore.getState().browserDraftTabId);
    const result = useRightPanelTabsStore.getState().openBrowserTab(limit, draft);
    if (result.tabId && result.status !== "limit_reached") {
      useBrowserPanelStore.getState().ensureTab(result.tabId);
      activateBrowserTab(result.tabId);
    }
    return;
  }
  if (plan.unknownOrder || plan.tabIds.some(isBrowserTabLeased)) {
    useBrowserCloseConfirmationStore.getState().request({
      kind: "overflow",
      continuation: { kind: "browser", url, ...(draftTabId ? { draftTabId } : {}) },
      ...plan,
    });
    return;
  }

  closeBrowserTabsAfterRevocation(plan.tabIds);
  finishBrowserOpen(url, limit, draftTabId);
}

function activateBrowserTabWithUrl(url: string): boolean {
  const existingTabId = findOpenBrowserTabWithUrl(url);
  if (!existingTabId) return false;
  activateBrowserTab(existingTabId);
  return true;
}

function findOpenBrowserTabWithUrl(url: string): RightPanelTabId | undefined {
  if (!url) return undefined;
  const { activeTabId, openTabs } = useRightPanelTabsStore.getState();
  const { tabsById } = useBrowserPanelStore.getState();
  const matches = (tabId: RightPanelTabId) =>
    isRightPanelTabOfKind(tabId, "browser") && matchesBrowserUrl(tabsById[tabId]?.url, url);
  return activeTabId && matches(activeTabId) ? activeTabId : openTabs.find(matches);
}

/** Handle an address submission that must reuse a page or go through the tab limit. */
export function resolveBrowserTabNavigation(tabId: RightPanelTabId, url: string): boolean {
  const existingTabId = findOpenBrowserTabWithUrl(url);
  if (existingTabId && existingTabId !== tabId) {
    const tab = useBrowserPanelStore.getState().tabsById[tabId];
    if (tab?.url === "" && !tab.agentLease && !tab.openedByAgent) {
      closeBrowserTabImmediately(tabId);
    }
    activateBrowserTab(existingTabId);
    return true;
  }
  if (useRightPanelTabsStore.getState().browserDraftTabId !== tabId) return false;
  openBrowserPage(url, tabId);
  return true;
}

function activateBrowserTab(tabId: RightPanelTabId) {
  requestRightPanel("browser");
  useRightPanelTabsStore.getState().setActiveTab(tabId);
  useBrowserPanelStore.getState().setOpen(true);
}

function finishBrowserOpen(url: string, limit: number, draftTabId?: RightPanelTabId) {
  if (draftTabId) {
    if (!useRightPanelTabsStore.getState().promoteBrowserDraft(draftTabId, limit)) return;
    useBrowserPanelStore.getState().setTabUrl(draftTabId, url);
    activateBrowserTab(draftTabId);
    return;
  }
  const result = useRightPanelTabsStore.getState().openBrowserTab(limit);
  if (result.status !== "created" || !result.tabId) return;
  const browserStore = useBrowserPanelStore.getState();
  browserStore.ensureTab(result.tabId, url);
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
      activateBrowserTab(lastBrowserTabId);
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
  if (browserTabIds.some(isBrowserTabLeased)) {
    useBrowserCloseConfirmationStore.getState().request({ kind: "close", tabIds: browserTabIds });
    return;
  }

  useRightPanelTabsStore.getState().closeTab("browser");
  requestRightPanel(useRightPanelTabsStore.getState().activeKind);
  useBrowserPanelStore.getState().removeTabs(browserTabIds);
  useBrowserPanelStore.getState().setOpen(false);
}

export function closeBrowserTab(tabId: RightPanelTabId) {
  if (isBrowserTabLeased(tabId)) {
    useBrowserCloseConfirmationStore.getState().request({ kind: "close", tabIds: [tabId] });
    return;
  }
  closeBrowserTabImmediately(tabId);
}

export function closeBrowserTabsAfterRevocation(tabIds: ReadonlyArray<RightPanelTabId>) {
  for (const tabId of tabIds) {
    closeBrowserTabImmediately(tabId);
  }
}

function getConfirmedClosePlan(request: BrowserCloseRequest): BrowserClosePlan | null {
  const confirmation = useBrowserCloseConfirmationStore.getState();
  if (confirmation.current !== request) return null;
  const limit = getBrowserTabLimit();
  if (request.kind === "close") {
    const { openTabs } = useRightPanelTabsStore.getState();
    return { limit, tabIds: request.tabIds.filter((tabId) => openTabs.includes(tabId)) };
  }

  const { continuation } = request;
  if (continuation.kind === "browser") {
    const { url, draftTabId } = continuation;
    const draftClosed =
      draftTabId && useRightPanelTabsStore.getState().browserDraftTabId !== draftTabId;
    const match = !draftClosed && findOpenBrowserTabWithUrl(url);
    if (draftClosed || match) {
      if (match) {
        if (draftTabId) closeBrowserTabImmediately(draftTabId);
        activateBrowserTab(match);
      }
      confirmation.dismiss();
      return null;
    }
  }
  const plan = planBrowserTabReplacements(limit, continuation.kind);
  if (continuation.kind === "game" && plan.tabIds.some(isBrowserTabLeased)) {
    confirmation.dismiss();
    continuation.onLeaseConflict(limit);
    return null;
  }
  if (
    (plan.unknownOrder && !request.unknownOrder) ||
    plan.tabIds.some((tabId) => !request.tabIds.includes(tabId))
  ) {
    // Capacity changed while the dialog was open: never silently close an unapproved tab.
    confirmation.request({ ...request, ...plan });
    return null;
  }
  return { limit, tabIds: plan.tabIds };
}

/** Revoke only leases shown in the dialog and close only the tabs the user approved. */
export async function confirmBrowserClose(
  request: BrowserCloseRequest,
  warnedLeaseIds: ReadonlySet<string>,
  revokeLease: (input: { tabId: RightPanelTabId; leaseId: string }) => Promise<unknown>,
): Promise<void> {
  const plan = getConfirmedClosePlan(request);
  if (!plan) return;
  if (request.kind === "overflow" && request.continuation.kind === "game") {
    useBrowserCloseConfirmationStore.getState().dismiss();
    request.continuation.resume(plan);
    return;
  }
  const browser = useBrowserPanelStore.getState();
  const leases = plan.tabIds.flatMap((tabId) => {
    const leaseId = browser.tabsById[tabId]?.agentLease?.leaseId;
    return leaseId ? [{ tabId, leaseId }] : [];
  });
  if (leases.some(({ leaseId }) => !warnedLeaseIds.has(leaseId))) return;

  if (leases.length > 0) {
    const results = await Promise.allSettled(
      leases.map(async ({ tabId, leaseId }) => {
        await revokeLease({ tabId, leaseId });
        browser.clearAgentLease(tabId, leaseId);
      }),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  const latest = getConfirmedClosePlan(request);
  if (!latest || latest.tabIds.some(isBrowserTabLeased)) return;
  useBrowserCloseConfirmationStore.getState().dismiss();
  closeBrowserTabsAfterRevocation(latest.tabIds);
  if (request.kind === "overflow" && request.continuation.kind === "browser") {
    finishBrowserOpen(request.continuation.url, latest.limit, request.continuation.draftTabId);
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

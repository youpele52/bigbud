import { DEFAULT_BROWSER_TAB_LIMIT } from "@bigbud/contracts/constants/browser.constant.ts";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { CLIENT_SETTINGS_STORAGE_KEY } from "~/hooks/useSettings.storage";

import {
  closeBrowserTab,
  closeBrowserPanel,
  confirmBrowserClose,
  openBrowserPanel,
  openNewBrowserTab,
  toggleBrowserPanel,
} from "./browserPanel.actions";
import { useBrowserPanelStore } from "./browser.store";
import { useBrowserCloseConfirmationStore } from "./browserCloseConfirmation.store";
import { useFilesPanelStore } from "../files/filesPanel.store";
import { getRequestedRightPanel, requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import {
  countRightPanelTabsByKind,
  useRightPanelTabsStore,
} from "../rightPanel/rightPanelTabs.store";

function setTabLimit(browserTabLimit: number) {
  setLocalStorageItem(
    CLIENT_SETTINGS_STORAGE_KEY,
    { ...DEFAULT_CLIENT_SETTINGS, browserTabLimit },
    ClientSettingsSchema,
  );
}

function openTabs(count: number) {
  for (let index = 0; index < count; index++) {
    openNewBrowserTab({ url: `https://example.com/${index}` });
  }
  return useRightPanelTabsStore.getState().browserCreationOrder;
}

describe("browserPanel.actions", () => {
  afterEach(() => {
    removeLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY);
    useBrowserPanelStore.setState({ open: false, tabsById: {} });
    useBrowserCloseConfirmationStore.getState().dismiss();
    useFilesPanelStore.setState({ open: false });
    useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      openTabs: [],
      browserCreationOrder: [],
      browserDraftTabId: null,
      rightPanelOpen: false,
    });
    requestRightPanel(null);
  });

  it("opens the browser with a normalized URL", () => {
    openBrowserPanel({ url: " https://example.com/path " });

    const browserTabIds = Object.keys(useBrowserPanelStore.getState().tabsById);

    expect(useBrowserPanelStore.getState()).toMatchObject({
      open: true,
      tabsById: {
        [browserTabIds[0] ?? ""]: {
          url: "https://example.com/path",
        },
      },
    });
  });

  it("keeps the files tab open while switching the active panel to browser", () => {
    useFilesPanelStore.setState({ open: true });
    requestRightPanel("files");
    useRightPanelTabsStore.setState({
      activeKind: "files",
      activeTabId: "files",
      openTabs: ["files"],
    });

    openBrowserPanel({ url: "https://example.com" });

    const browserTabIds = Object.keys(useBrowserPanelStore.getState().tabsById);

    expect(useFilesPanelStore.getState().open).toBe(true);
    expect(useBrowserPanelStore.getState().open).toBe(true);
    expect(getRequestedRightPanel()).toBe("browser");
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      activeTabId: browserTabIds[0],
      openTabs: ["files", browserTabIds[0]],
    });
  });

  it("activates the browser instead of closing it when the tab is already open in the background", () => {
    openBrowserPanel({ url: "https://example.com" });
    const browserTabId = Object.keys(useBrowserPanelStore.getState().tabsById)[0] as
      | `browser:${string}`
      | undefined;

    expect(browserTabId).toBeTruthy();

    useRightPanelTabsStore.setState({
      activeKind: "files",
      activeTabId: "files",
      openTabs: [browserTabId ?? "browser", "files"],
      rightPanelOpen: true,
    });

    toggleBrowserPanel();

    expect(useBrowserPanelStore.getState().open).toBe(true);
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      activeTabId: browserTabId,
      openTabs: [browserTabId ?? "browser", "files"],
      rightPanelOpen: true,
    });
  });

  it("closes the browser only when toggling the active browser tab", () => {
    toggleBrowserPanel();
    expect(useBrowserPanelStore.getState().open).toBe(true);

    toggleBrowserPanel();
    expect(useBrowserPanelStore.getState().open).toBe(false);
    expect(countRightPanelTabsByKind(useRightPanelTabsStore.getState().openTabs, "browser")).toBe(
      0,
    );
  });

  it("closes the browser panel without mutating the current URL", () => {
    openBrowserPanel({ url: "https://example.com" });
    openNewBrowserTab({ url: "https://bigbud.dev" });

    closeBrowserPanel();

    expect(useBrowserPanelStore.getState()).toMatchObject({
      open: false,
      tabsById: {},
    });
    expect(getRequestedRightPanel()).toBeNull();
  });

  it("asks before closing an agent-controlled browser tab", () => {
    openBrowserPanel({ url: "https://example.com" });
    const tabId = Object.keys(useBrowserPanelStore.getState().tabsById)[0] as `browser:${string}`;
    useBrowserPanelStore.getState().setAgentLease(tabId, {
      leaseId: "lease:1",
      threadId: "thread:1",
      turnId: "turn:1",
    });

    closeBrowserTab(tabId);

    expect(useRightPanelTabsStore.getState().openTabs).toContain(tabId);
    expect(useBrowserPanelStore.getState().tabsById[tabId]?.agentLease).toBeDefined();
    expect(useBrowserCloseConfirmationStore.getState().current).toEqual({
      kind: "close",
      tabIds: [tabId],
    });
  });

  it("opens a new browser tab without mutating the current browser tab", () => {
    openBrowserPanel({ url: "https://example.com" });
    const firstTabId = Object.keys(useBrowserPanelStore.getState().tabsById)[0] ?? "";

    openNewBrowserTab({ url: "https://bigbud.dev" });

    const { activeTabId, openTabs } = useRightPanelTabsStore.getState();
    const tabsById = useBrowserPanelStore.getState().tabsById;

    expect(openTabs).toHaveLength(2);
    expect(tabsById[firstTabId]?.url).toBe("https://example.com");
    expect(activeTabId).not.toBe(firstTabId);
    expect(activeTabId ? tabsById[activeTabId]?.url : null).toBe("https://bigbud.dev");
  });

  it("focuses the matching tab at capacity without changing opening order or closing a tab", () => {
    const ids = openTabs(DEFAULT_BROWSER_TAB_LIMIT);
    const matchingTabId = ids[1]!;
    const url = "https://example.com/";
    const browser = useBrowserPanelStore.getState();
    browser.setTabUrl(matchingTabId, url);
    useRightPanelTabsStore.getState().closeRightPanel();
    browser.setOpen(false);

    openNewBrowserTab({ url: " https://EXAMPLE.com:443 " });

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      openTabs: ids,
      browserCreationOrder: ids,
      activeTabId: matchingTabId,
      rightPanelOpen: true,
    });
    expect(useBrowserPanelStore.getState()).toMatchObject({
      open: true,
      tabsById: { [matchingTabId]: { url } },
    });
    expect(useBrowserCloseConfirmationStore.getState().current).toBeNull();
  });

  it("keeps different query strings, fragments, and blank tabs separate", () => {
    openNewBrowserTab({ url: "https://example.com/?q=1#top" });
    openNewBrowserTab({ url: "https://example.com/?q=2#top" });
    openNewBrowserTab({ url: "https://example.com/?q=1#bottom" });
    openNewBrowserTab();
    openNewBrowserTab();

    expect(useRightPanelTabsStore.getState().openTabs).toHaveLength(5);
  });

  it("focuses an existing URL instead of navigating the active tab when opening a link", () => {
    const [matchingTabId, activeTabId] = openTabs(2);
    openBrowserPanel({ url: "https://example.com/0" });

    expect(useRightPanelTabsStore.getState().activeTabId).toBe(matchingTabId);
    expect(useBrowserPanelStore.getState().tabsById[activeTabId!]?.url).toBe(
      "https://example.com/1",
    );
  });

  it("opens unmatched links without navigating an agent-controlled page", () => {
    const [leasedTabId] = openTabs(1);
    const browser = useBrowserPanelStore.getState();
    browser.setAgentLease(leasedTabId!, { leaseId: "lease", threadId: "thread", turnId: "turn" });

    openBrowserPanel({ url: "https://example.com/new" });

    const { openTabs: tabs, activeTabId } = useRightPanelTabsStore.getState();
    expect(tabs).toEqual([leasedTabId, activeTabId]);
    expect(useBrowserPanelStore.getState().tabsById[leasedTabId!]?.url).toBe(
      "https://example.com/0",
    );
    expect(useBrowserPanelStore.getState().tabsById[activeTabId!]?.url).toBe(
      "https://example.com/new",
    );
  });

  it("reuses a matching tab that appears while overflow confirmation is open", async () => {
    const ids = openTabs(DEFAULT_BROWSER_TAB_LIMIT);
    const [oldest, matchingTabId] = ids;
    const browser = useBrowserPanelStore.getState();
    browser.setAgentLease(oldest!, { leaseId: "lease", threadId: "thread", turnId: "turn" });
    const url = "https://example.com/new";
    openNewBrowserTab({ url });
    const request = useBrowserCloseConfirmationStore.getState().current!;
    expect(request.tabIds).toEqual([oldest]);
    browser.setTabUrl(matchingTabId!, url);

    const revokeLease = vi.fn();
    await confirmBrowserClose(request, new Set(["lease"]), revokeLease);

    expect(revokeLease).not.toHaveBeenCalled();
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeTabId: matchingTabId,
      openTabs: ids,
    });
    expect(useBrowserCloseConfirmationStore.getState().current).toBeNull();
  });

  it("replaces the oldest of five tabs regardless of dragging and activation", () => {
    const [oldest, second, ...rest] = openTabs(DEFAULT_BROWSER_TAB_LIMIT);
    useRightPanelTabsStore.getState().moveTab(oldest!, rest.at(-1)!, "after");
    useRightPanelTabsStore.getState().setActiveTab(oldest!);

    openNewBrowserTab({ url: "https://example.com/overflow" });

    const { openTabs: visibleTabs, activeTabId } = useRightPanelTabsStore.getState();
    expect(visibleTabs).toEqual([second, ...rest, activeTabId]);
    expect(useBrowserPanelStore.getState().tabsById[oldest!]).toBeUndefined();
    expect(useBrowserPanelStore.getState().tabsById[activeTabId!]?.url).toBe(
      "https://example.com/overflow",
    );
  });

  it("honors a higher cap and waits for the next new tab to enforce a lower cap", () => {
    setTabLimit(6);
    const ids = openTabs(6);
    expect(ids).toHaveLength(6);
    setTabLimit(3);
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(ids);

    openNewBrowserTab({ url: "https://example.com/new" });

    const { openTabs: visibleTabs, activeTabId } = useRightPanelTabsStore.getState();
    expect(visibleTabs).toEqual([...ids.slice(4), activeTabId]);
    expect(useBrowserCloseConfirmationStore.getState().current).toBeNull();
  });

  it("does not close any tab when an unknown-order multi-tab replacement is canceled", async () => {
    const ids = openTabs(5);
    useRightPanelTabsStore.setState({ browserCreationOrder: ids.slice(1) });
    setTabLimit(3);

    openNewBrowserTab({ url: "https://example.com/overflow" });
    const confirmation = useBrowserCloseConfirmationStore.getState();
    expect(confirmation.current).toMatchObject({
      kind: "overflow",
      unknownOrder: true,
      tabIds: ids.slice(0, 3),
    });
    confirmation.dismiss();
    const revokeLease = vi.fn();
    await confirmBrowserClose(confirmation.current!, new Set(), revokeLease);
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(ids);
    expect(revokeLease).not.toHaveBeenCalled();
  });

  it("rechecks capacity before closing tabs the user has not approved", async () => {
    const ids = openTabs(5);
    useRightPanelTabsStore.setState({ browserCreationOrder: ids.slice(2) });
    openNewBrowserTab({ url: "https://example.com/new" });
    const request = useBrowserCloseConfirmationStore.getState().current!;
    expect(request.tabIds).toEqual(ids.slice(0, 1));
    setTabLimit(3);

    await confirmBrowserClose(request, new Set(), vi.fn());
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(ids);
    expect(useBrowserCloseConfirmationStore.getState().current?.tabIds).toEqual(ids.slice(0, 3));
  });

  it("waits for successful lease revocation before closing the oldest tab and continuing", async () => {
    const [oldest, ...rest] = openTabs(5);
    useBrowserPanelStore.getState().setAgentLease(oldest!, {
      leaseId: "lease:1",
      threadId: "thread:1",
      turnId: "turn:1",
    });
    openNewBrowserTab({ url: "https://example.com/overflow" });
    const request = useBrowserCloseConfirmationStore.getState().current!;
    expect(request).toMatchObject({ kind: "overflow", tabIds: [oldest] });
    expect(useRightPanelTabsStore.getState().openTabs).toEqual([oldest, ...rest]);
    const revokeLease = vi.fn().mockRejectedValueOnce(new Error("revocation rejected"));
    await expect(confirmBrowserClose(request, new Set(["lease:1"]), revokeLease)).rejects.toThrow(
      "revocation rejected",
    );
    expect(useRightPanelTabsStore.getState().openTabs).toEqual([oldest, ...rest]);
    expect(useBrowserPanelStore.getState().tabsById[oldest!]?.agentLease?.leaseId).toBe("lease:1");

    await confirmBrowserClose(request, new Set(["lease:1"]), revokeLease);
    expect(revokeLease).toHaveBeenLastCalledWith({ tabId: oldest, leaseId: "lease:1" });
    const { openTabs: visibleTabs, activeTabId } = useRightPanelTabsStore.getState();
    expect(visibleTabs).toEqual([...rest, activeTabId]);
    expect(useBrowserPanelStore.getState().tabsById[activeTabId!]?.url).toBe(
      "https://example.com/overflow",
    );
  });

  it("does not clear a replacement lease acquired while the old lease is revoking", async () => {
    const ids = openTabs(5);
    const browser = useBrowserPanelStore.getState();
    browser.setAgentLease(ids[0]!, { leaseId: "lease:old", threadId: "thread", turnId: "turn" });
    openNewBrowserTab({ url: "https://example.com/new" });
    const request = useBrowserCloseConfirmationStore.getState().current!;

    const revokeLease = vi.fn().mockImplementation(async () => {
      browser.setAgentLease(ids[0]!, { leaseId: "lease:new", threadId: "thread", turnId: "turn" });
    });
    await confirmBrowserClose(request, new Set(["lease:old"]), revokeLease);

    expect(useRightPanelTabsStore.getState().openTabs).toEqual(ids);
    expect(useBrowserPanelStore.getState().tabsById[ids[0]!]?.agentLease?.leaseId).toBe(
      "lease:new",
    );
    expect(useBrowserCloseConfirmationStore.getState().current).toBe(request);
  });
});

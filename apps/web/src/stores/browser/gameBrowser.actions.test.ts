import { afterEach, describe, expect, it, vi } from "vitest";
import { openGameBrowserTab } from "./gameBrowser.actions";
import { confirmBrowserClose, openNewBrowserTab } from "./browserPanel.actions";
import { useBrowserPanelStore } from "./browser.store";
import { useBrowserCloseConfirmationStore } from "./browserCloseConfirmation.store";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { GAMES } from "@bigbud/shared/games";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { removeLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { CLIENT_SETTINGS_STORAGE_KEY } from "~/hooks/useSettings.storage";
import { toastManager } from "~/components/ui/toast";

const game = () => ({ name: "Snake", url: "https://playsnake.org/", onOpened: vi.fn() });
function fillTabs() {
  for (let index = 0; index < 5; index++)
    openNewBrowserTab({ url: `https://example.com/${index}` });
  return [...useRightPanelTabsStore.getState().browserCreationOrder];
}

afterEach(() => {
  removeLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY);
  useBrowserPanelStore.setState({ open: false, tabsById: {} });
  useRightPanelTabsStore.setState({
    openTabs: [],
    gamesWidthTabId: null,
    browserCreationOrder: [],
    activeKind: null,
    activeTabId: null,
    rightPanelOpen: false,
  });
  useBrowserCloseConfirmationStore.getState().dismiss();
  requestRightPanel(null);
});

describe("game browser launch", () => {
  it("opens the exact URL in a fresh visible tab without replacing an existing tab", () => {
    const first = game();
    expect(openGameBrowserTab(first)).toBe(true);
    const original = useRightPanelTabsStore.getState().activeTabId!;
    const second = game();
    expect(openGameBrowserTab(second)).toBe(true);
    expect(useBrowserPanelStore.getState().tabsById[original]?.url).toBe(first.url);
    expect(useRightPanelTabsStore.getState().activeTabId).not.toBe(original);
    expect(useRightPanelTabsStore.getState().rightPanelOpen).toBe(true);
    expect(useRightPanelTabsStore.getState().gamesWidthTabId).toBe(
      useRightPanelTabsStore.getState().activeTabId,
    );
    expect(second.onOpened).toHaveBeenCalledOnce();
  });

  it("opens Retro Games at its exact approved URL", () => {
    const retroGames = GAMES.find((entry) => entry.name === "Retro Games")!;
    expect(
      openGameBrowserTab({ name: retroGames.name, url: retroGames.url, onOpened: vi.fn() }),
    ).toBe(true);
    const activeTabId = useRightPanelTabsStore.getState().activeTabId!;
    expect(useBrowserPanelStore.getState().tabsById[activeTabId]?.url).toBe(
      "https://www.retrogames.cz/",
    );
  });

  it("opens Lagos Life from the Social & puzzles group at its exact approved URL", () => {
    const lagosLife = GAMES.find((entry) => entry.name === "Lagos Life")!;
    expect(lagosLife.category).toBe("Social & puzzles");
    expect(
      openGameBrowserTab({ name: lagosLife.name, url: lagosLife.url, onOpened: vi.fn() }),
    ).toBe(true);
    const activeTabId = useRightPanelTabsStore.getState().activeTabId!;
    expect(useBrowserPanelStore.getState().tabsById[activeTabId]?.url).toBe(
      "https://lagoslife.app/",
    );
  });

  it("evicts the earliest created tab after reorder, including an agent-opened unleased tab", () => {
    const ids = fillTabs();
    useBrowserPanelStore.getState().markTabOpenedByAgent(ids[0]!);
    useRightPanelTabsStore.getState().moveTab(ids[0]!, ids[4]!, "after");
    expect(useRightPanelTabsStore.getState().openTabs.at(-1)).toBe(ids[0]);
    expect(openGameBrowserTab(game())).toBe(true);
    expect(useBrowserPanelStore.getState().tabsById[ids[0]!]).toBeUndefined();
    expect(useBrowserPanelStore.getState().tabsById[ids[1]!]?.url).toBe("https://example.com/1");
    expect(useRightPanelTabsStore.getState().openTabs).toHaveLength(5);
  });

  it("never revokes a leased oldest tab or silently skips; retry succeeds after manual close", () => {
    const ids = fillTabs();
    useBrowserPanelStore
      .getState()
      .setAgentLease(ids[0]!, { leaseId: "lease", threadId: "thread", turnId: "turn" });
    const selected = game();
    expect(openGameBrowserTab(selected)).toBe(false);
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(ids);
    expect(useBrowserCloseConfirmationStore.getState().current).toBeNull();
    useRightPanelTabsStore.getState().closeTabById(ids[4]!);
    useBrowserPanelStore.getState().removeTab(ids[4]!);
    expect(openGameBrowserTab(selected)).toBe(true);
    expect(useBrowserPanelStore.getState().tabsById[ids[0]!]?.agentLease?.leaseId).toBe("lease");
    expect(selected.onOpened).toHaveBeenCalledOnce();
  });

  it("makes enough room after lowering the cap without skipping or evicting leased tabs", () => {
    const ids = fillTabs();
    setLocalStorageItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      { ...DEFAULT_CLIENT_SETTINGS, browserTabLimit: 3 },
      ClientSettingsSchema,
    );
    useBrowserPanelStore
      .getState()
      .setAgentLease(ids[1]!, { leaseId: "lease", threadId: "thread", turnId: "turn" });

    expect(openGameBrowserTab(game())).toBe(false);
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(ids);
    expect(useBrowserCloseConfirmationStore.getState().current).toBeNull();

    useBrowserPanelStore.getState().clearAgentLease(ids[1]!);
    expect(openGameBrowserTab(game())).toBe(true);
    const { activeTabId, openTabs } = useRightPanelTabsStore.getState();
    expect(openTabs).toEqual([...ids.slice(3), activeTabId]);
  });

  it("does not evict tabs through the Retry toast after an agent releases a lease", () => {
    const ids = fillTabs();
    setLocalStorageItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      { ...DEFAULT_CLIENT_SETTINGS, browserTabLimit: 3 },
      ClientSettingsSchema,
    );
    const browser = useBrowserPanelStore.getState();
    browser.setAgentLease(ids[0]!, { leaseId: "lease", threadId: "thread", turnId: "turn" });
    const toast = vi.spyOn(toastManager, "add");
    const selected = game();
    try {
      expect(openGameBrowserTab(selected)).toBe(false);
      const retry = toast.mock.lastCall?.[0]?.actionProps?.onClick;
      expect(retry).toBeDefined();
      const click = {} as Parameters<NonNullable<typeof retry>>[0];
      browser.clearAgentLease(ids[0]!);
      retry?.(click);

      expect(useRightPanelTabsStore.getState().openTabs).toEqual(ids);
      expect(toast.mock.lastCall?.[0]?.description).toBe(
        "Close 3 browser tabs manually, then retry.",
      );
      for (const id of ids.slice(0, 3)) useRightPanelTabsStore.getState().closeTabById(id);
      retry?.(click);
      const { openTabs, activeTabId } = useRightPanelTabsStore.getState();
      expect(openTabs).toEqual([...ids.slice(3), activeTabId]);
      expect(selected.onOpened).toHaveBeenCalledOnce();
    } finally {
      toast.mockRestore();
    }
  });

  it("offers manual retry if a late lease leaves Games without an unleased replacement", async () => {
    const ids = fillTabs();
    useRightPanelTabsStore.setState({ browserCreationOrder: ids.slice(1) });
    const selected = game();
    expect(openGameBrowserTab(selected)).toBe(false);
    const request = useBrowserCloseConfirmationStore.getState().current!;
    expect(request).toMatchObject({ kind: "overflow", tabIds: [ids[0]], unknownOrder: true });
    for (const id of ids) {
      useBrowserPanelStore.getState().setAgentLease(id, {
        leaseId: `lease:${id}`,
        threadId: "thread",
        turnId: "turn",
      });
    }
    const revokeLease = vi.fn();
    const toast = vi.spyOn(toastManager, "add");
    try {
      await confirmBrowserClose(request, new Set([`lease:${ids[0]}`]), revokeLease);
      expect(revokeLease).not.toHaveBeenCalled();
      expect(useRightPanelTabsStore.getState().openTabs).toEqual(ids);
      expect(useBrowserPanelStore.getState().tabsById[ids[0]!]?.agentLease?.leaseId).toBe(
        `lease:${ids[0]}`,
      );
      expect(useBrowserCloseConfirmationStore.getState().current).toBeNull();
      expect(selected.onOpened).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          description: expect.stringContaining("Close browser tabs manually, then retry."),
          actionProps: expect.objectContaining({ children: "Retry" }),
        }),
      );
    } finally {
      toast.mockRestore();
    }
  });

  it("rejects a concurrent launch without opening a second tab", () => {
    const nested = game();
    const selected = { ...game(), onOpened: () => expect(openGameBrowserTab(nested)).toBe(false) };
    expect(openGameBrowserTab(selected)).toBe(true);
    expect(useRightPanelTabsStore.getState().openTabs).toHaveLength(1);
    expect(nested.onOpened).not.toHaveBeenCalled();
  });

  it("keeps unrelated browser opens on ordinary width and clears Games sizing on close", () => {
    openNewBrowserTab({ url: "https://example.com" });
    expect(useRightPanelTabsStore.getState().gamesWidthTabId).toBeNull();
    expect(openGameBrowserTab(game())).toBe(true);
    const gameTabId = useRightPanelTabsStore.getState().activeTabId!;
    expect(useRightPanelTabsStore.getState().gamesWidthTabId).toBe(gameTabId);
    useRightPanelTabsStore.getState().closeTabById(gameTabId);
    expect(useRightPanelTabsStore.getState().gamesWidthTabId).toBeNull();
  });
});

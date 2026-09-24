import { afterEach, describe, expect, it, vi } from "vitest";
import { openGameBrowserTab } from "./gameBrowser.actions";
import { openNewBrowserTab } from "./browserPanel.actions";
import { useBrowserPanelStore } from "./browser.store";
import { useBrowserCloseConfirmationStore } from "./browserCloseConfirmation.store";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { GAMES } from "@bigbud/shared/games";

const game = () => ({ name: "Snake", url: "https://playsnake.org/", onOpened: vi.fn() });
function fillTabs() {
  for (let index = 0; index < 5; index++)
    openNewBrowserTab({ url: `https://example.com/${index}` });
  return [...useRightPanelTabsStore.getState().browserCreationOrder];
}

afterEach(() => {
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
    expect(useBrowserCloseConfirmationStore.getState().tabIds).toHaveLength(0);
    useRightPanelTabsStore.getState().closeTabById(ids[4]!);
    useBrowserPanelStore.getState().removeTab(ids[4]!);
    expect(openGameBrowserTab(selected)).toBe(true);
    expect(useBrowserPanelStore.getState().tabsById[ids[0]!]?.agentLease?.leaseId).toBe("lease");
    expect(selected.onOpened).toHaveBeenCalledOnce();
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

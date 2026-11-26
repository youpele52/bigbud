import "../../index.css";

import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { removeLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { CLIENT_SETTINGS_STORAGE_KEY } from "~/hooks/useSettings.storage";
import { useBrowserPanelStore } from "~/stores/browser/browser.store";
import { useBrowserCloseConfirmationStore } from "~/stores/browser/browserCloseConfirmation.store";
import {
  closeBrowserTab,
  openNewBrowserTab,
  resolveBrowserTabNavigation,
} from "~/stores/browser/browserPanel.actions";
import { openGameBrowserTab } from "~/stores/browser/gameBrowser.actions";
import { requestRightPanel } from "~/stores/rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "~/stores/rightPanel/rightPanelTabs.store";
import { BrowserCloseConfirmation } from "../browser/BrowserCloseConfirmation";
import { RightPanelTabs } from "./RightPanelTabs";

afterEach(() => {
  removeLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY);
  useBrowserCloseConfirmationStore.getState().dismiss();
  useBrowserPanelStore.setState({ open: false, tabsById: {} });
  useRightPanelTabsStore.setState(useRightPanelTabsStore.getInitialState(), true);
  requestRightPanel(null);
});

function seedBrowserTabs(unknownIndex: number) {
  for (let index = 0; index < 5; index++) {
    openNewBrowserTab({ url: `https://example.com/${index}` });
  }
  const { openTabs } = useRightPanelTabsStore.getState();
  const unknownTabId = openTabs[unknownIndex]!;
  useBrowserPanelStore.getState().setTabTitle(unknownTabId, "Example Docs");
  useRightPanelTabsStore.setState({
    browserCreationOrder: openTabs.filter((id) => id !== unknownTabId),
  });
  return { openTabs, unknownTabId };
}

it("keeps + Browser available and confirms a named fallback before replacing tabs", async () => {
  const { openTabs } = seedBrowserTabs(3);
  setLocalStorageItem(
    CLIENT_SETTINGS_STORAGE_KEY,
    { ...DEFAULT_CLIENT_SETTINGS, browserTabLimit: 3 },
    ClientSettingsSchema,
  );

  const noop = vi.fn();
  const mounted = await render(
    <>
      <RightPanelTabs
        browserShortcutLabel={null}
        filesShortcutLabel={null}
        hasActiveProject
        onCloseBrowserTab={closeBrowserTab}
        onCloseFiles={noop}
        onCloseSystem={noop}
        onCloseUsage={noop}
        onCloseTerminal={noop}
        onOpenNewBrowserTab={openNewBrowserTab}
        onOpenFiles={noop}
        onOpenSystem={noop}
        onOpenUsage={noop}
        onOpenTerminal={noop}
        terminalAvailable
        terminalShortcutLabel={null}
      />
      <BrowserCloseConfirmation />
    </>,
  );
  try {
    const openMenu = async () => {
      await page.getByRole("button", { name: "Open another right panel tab" }).click();
      await page.getByRole("menuitem", { name: "Browser", exact: true }).click();
      const { browserDraftTabId } = useRightPanelTabsStore.getState();
      expect(browserDraftTabId).not.toBeNull();
      expect(useRightPanelTabsStore.getState().openTabs).toEqual([...openTabs, browserDraftTabId]);
      resolveBrowserTabNavigation(browserDraftTabId!, "https://example.com/new");
      return browserDraftTabId;
    };
    const dialog = page.getByRole("alertdialog");
    const draft = await openMenu();
    await expect.element(dialog).toHaveTextContent("couldn't determine the oldest tab");
    await expect.element(dialog).toHaveTextContent("Example Docs");
    await expect.element(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(dialog).not.toBeInTheDocument();
    expect(useRightPanelTabsStore.getState().openTabs).toEqual([...openTabs, draft]);
    closeBrowserTab(draft!);

    const promoted = await openMenu();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    const { openTabs: after, activeTabId } = useRightPanelTabsStore.getState();
    expect(after).toEqual([openTabs[2], openTabs[4], activeTabId]);
    expect(activeTabId).toBe(promoted);
    expect(useRightPanelTabsStore.getState().browserDraftTabId).toBeNull();
    expect(openTabs).not.toContain(activeTabId);
  } finally {
    await mounted.unmount();
  }
});

it("confirms a named Games replacement and opens in game width only after Continue", async () => {
  const { openTabs, unknownTabId } = seedBrowserTabs(2);
  const game = { name: "Snake", url: "https://playsnake.org/", onOpened: vi.fn() };
  const mounted = await render(
    <>
      <button type="button" onClick={() => openGameBrowserTab(game)}>
        Play Snake
      </button>
      <BrowserCloseConfirmation />
    </>,
  );
  try {
    const play = page.getByRole("button", { name: "Play Snake" });
    const dialog = page.getByRole("alertdialog");
    await play.click();
    await expect.element(dialog).toHaveTextContent("couldn't determine the oldest tab");
    await expect.element(dialog).toHaveTextContent("Example Docs");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(openTabs);
    expect(useRightPanelTabsStore.getState().gamesWidthTabId).toBeNull();
    expect(game.onOpened).not.toHaveBeenCalled();

    await play.click();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    const { openTabs: after, activeTabId, gamesWidthTabId } = useRightPanelTabsStore.getState();
    expect(after).toEqual([...openTabs.filter((id) => id !== unknownTabId), activeTabId]);
    expect(gamesWidthTabId).toBe(activeTabId);
    expect(useBrowserPanelStore.getState().tabsById[activeTabId!]?.url).toBe(game.url);
    expect(game.onOpened).toHaveBeenCalledOnce();
  } finally {
    await mounted.unmount();
  }
});

it.each(["before opening", "while reviewing"])(
  "Games offers an unleased replacement when the first choice is leased %s",
  async (leaseTiming) => {
    const { openTabs, unknownTabId } = seedBrowserTabs(2);
    const alternative = openTabs[0]!;
    const browser = useBrowserPanelStore.getState();
    browser.setTabTitle(alternative, "Example News");
    const lease = () =>
      browser.setAgentLease(unknownTabId, {
        leaseId: "lease:kept",
        threadId: "thread",
        turnId: "turn",
      });
    const game = { name: "Snake", url: "https://playsnake.org/", onOpened: vi.fn() };
    const mounted = await render(<BrowserCloseConfirmation />);
    try {
      if (leaseTiming === "before opening") lease();
      openGameBrowserTab(game);
      const dialog = page.getByRole("alertdialog");
      if (leaseTiming === "while reviewing") {
        await expect.element(dialog).toHaveTextContent("Example Docs");
        lease();
        await expect.element(dialog).toHaveTextContent("Games can’t close “Example Docs”");
        await expect.element(dialog).not.toHaveTextContent("Continuing will close");
        await dialog.getByRole("button", { name: "Review replacement" }).click();
        await expect.element(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
      }
      await expect.element(dialog).toHaveTextContent("Continuing will close “Example News”");
      expect(useRightPanelTabsStore.getState().openTabs).toEqual(openTabs);
      expect(game.onOpened).not.toHaveBeenCalled();

      await dialog.getByRole("button", { name: "Continue" }).click();
      const { openTabs: after, activeTabId } = useRightPanelTabsStore.getState();
      expect(after).toEqual([...openTabs.slice(1), activeTabId]);
      expect(useBrowserPanelStore.getState().tabsById[unknownTabId]?.agentLease?.leaseId).toBe(
        "lease:kept",
      );
      expect(game.onOpened).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  },
);

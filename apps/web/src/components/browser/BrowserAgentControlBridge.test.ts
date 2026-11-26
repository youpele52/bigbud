import { ThreadId, TurnId, type VisibleBrowserCommand } from "@bigbud/contracts";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { CLIENT_SETTINGS_STORAGE_KEY } from "~/hooks/useSettings.storage";
import { useBrowserPanelStore } from "~/stores/browser/browser.store";
import { openNewBrowserTab } from "~/stores/browser/browserPanel.actions";
import { useRightPanelTabsStore } from "~/stores/rightPanel/rightPanelTabs.store";
import {
  clearVisibleBrowserRendererLease,
  executeAndCompleteVisibleBrowserCommand,
  executeVisibleBrowserCommand,
  reconcileBrowserLeases,
} from "./BrowserAgentControlBridge";

describe("BrowserAgentControlBridge", () => {
  beforeEach(() => {
    useBrowserPanelStore.setState({ open: false, tabsById: {} });
    useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      openTabs: [],
      browserCreationOrder: [],
      rightPanelOpen: false,
      lastActiveKind: null,
    });
  });

  afterEach(() => {
    removeLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY);
  });

  it("returns the configured cap and asks the user without evicting any tabs", async () => {
    setLocalStorageItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      { ...DEFAULT_CLIENT_SETTINGS, browserTabLimit: 3 },
      ClientSettingsSchema,
    );
    for (let index = 0; index < 3; index++) {
      openNewBrowserTab({ url: `https://example.com/${index}` });
    }
    const { openTabs } = useRightPanelTabsStore.getState();
    useBrowserPanelStore.getState().markTabOpenedByAgent(openTabs[0]!);

    const result = await executeVisibleBrowserCommand({
      commandId: "command:limit",
      leaseId: "lease:limit",
      rendererId: "renderer:1",
      threadId: ThreadId.makeUnsafe("thread:1"),
      turnId: TurnId.makeUnsafe("turn:1"),
      action: { action: "capture", target: "visible" },
    });

    expect(result).toEqual({
      action: "capture",
      summary:
        "Browser tab limit reached (3). Ask the user which tab to close before opening another.",
      target: "visible",
      selectionReason: "tab_limit_reached",
      tabLimit: {
        limit: 3,
        tabs: openTabs.map((tabId, index) => ({
          tabId,
          title: "",
          url: `https://example.com/${index}`,
          openedByAgent: index === 0,
        })),
      },
    });
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(openTabs);
  });

  it("revokes reload-orphaned leases while preserving leases for existing tabs", async () => {
    const existingTabId = "browser:existing";
    useBrowserPanelStore.getState().ensureTab(existingTabId, "https://example.com");
    useRightPanelTabsStore.setState({ openTabs: [existingTabId] });
    const leases = [
      {
        leaseId: "lease:existing",
        tabId: existingTabId,
        threadId: ThreadId.makeUnsafe("thread:existing"),
        turnId: TurnId.makeUnsafe("turn:existing"),
      },
      {
        leaseId: "lease:orphaned",
        tabId: "browser:destroyed-by-reload",
        threadId: ThreadId.makeUnsafe("thread:orphaned"),
        turnId: TurnId.makeUnsafe("turn:orphaned"),
      },
    ];
    const browser = {
      getLeases: vi.fn().mockResolvedValue(leases),
      revokeLease: vi.fn().mockResolvedValue(undefined),
    };

    await reconcileBrowserLeases("renderer:reloaded", browser);

    expect(browser.revokeLease).toHaveBeenCalledOnce();
    expect(browser.revokeLease).toHaveBeenCalledWith({
      rendererId: "renderer:reloaded",
      leaseId: "lease:orphaned",
      tabId: "browser:destroyed-by-reload",
    });
    expect(useBrowserPanelStore.getState().tabsById[existingTabId]?.agentLease).toEqual({
      leaseId: "lease:existing",
      threadId: "thread:existing",
      turnId: "turn:existing",
    });
  });

  it("clears established renderer control after a command failure", () => {
    const store = useBrowserPanelStore.getState();
    store.ensureTab("browser:controlled", "https://example.com");
    store.setAgentLease("browser:controlled", {
      leaseId: "lease:failed",
      threadId: "thread:1",
      turnId: "turn:1",
    });

    clearVisibleBrowserRendererLease("lease:failed");

    expect(
      useBrowserPanelStore.getState().tabsById["browser:controlled"]?.agentLease,
    ).toBeUndefined();
    expect(useBrowserPanelStore.getState().tabsById["browser:controlled"]?.agentHandoff).toEqual(
      expect.objectContaining({ leaseId: "lease:failed" }),
    );
  });

  it("does not report command failure when successful completion transport rejects", async () => {
    const command: VisibleBrowserCommand = {
      commandId: "command:1",
      leaseId: "lease:1",
      rendererId: "renderer:1",
      threadId: ThreadId.makeUnsafe("thread:1"),
      turnId: TurnId.makeUnsafe("turn:1"),
      action: { action: "capture", target: "visible" },
    };
    const result = {
      action: "capture" as const,
      summary: "Captured visible browser.",
      tabId: "browser:controlled",
      target: "visible" as const,
    };
    const complete = vi.fn().mockRejectedValue(new Error("transport unavailable"));
    const reconcile = vi.fn();
    const store = useBrowserPanelStore.getState();
    store.ensureTab(result.tabId, "https://example.com");
    store.setAgentLease(result.tabId, {
      leaseId: command.leaseId,
      threadId: command.threadId,
      turnId: command.turnId,
    });

    await executeAndCompleteVisibleBrowserCommand({
      command,
      rendererId: command.rendererId,
      execute: vi.fn().mockResolvedValue(result),
      complete,
      reconcile,
    });

    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith({
      commandId: command.commandId,
      rendererId: command.rendererId,
      result,
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(useBrowserPanelStore.getState().tabsById[result.tabId]?.agentLease).toMatchObject({
      leaseId: command.leaseId,
    });
  });
});

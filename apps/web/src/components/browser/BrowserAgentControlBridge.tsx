import { useEffect, useRef } from "react";
import type { BrowserAction, BrowserResult, VisibleBrowserCommand } from "@bigbud/contracts";

import { getWsRpcClient } from "~/rpc/wsRpcClient";
import type { WsRpcClient } from "~/rpc/wsRpcClient.types";
import { useBrowserPanelStore } from "~/stores/browser/browser.store";
import { closeBrowserTabsAfterRevocation } from "~/stores/browser/browserPanel.actions";
import {
  isRightPanelTabOfKind,
  MAX_RIGHT_PANEL_BROWSER_TABS,
  type RightPanelTabId,
  useRightPanelTabsStore,
} from "~/stores/rightPanel/rightPanelTabs.store";
import { waitForBrowserTabAgentHandler } from "./browserAgentControl";

const VISIBLE_BROWSER_RENDERER_ID_KEY = "bigbud.visible-browser-renderer-id";

export function getVisibleBrowserRendererId(): string {
  if (typeof window === "undefined") {
    return `renderer:${crypto.randomUUID()}`;
  }
  try {
    const existing = window.sessionStorage.getItem(VISIBLE_BROWSER_RENDERER_ID_KEY);
    if (existing) return existing;
    const rendererId = `renderer:${crypto.randomUUID()}`;
    window.sessionStorage.setItem(VISIBLE_BROWSER_RENDERER_ID_KEY, rendererId);
    return rendererId;
  } catch {
    return `renderer:${crypto.randomUUID()}`;
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Visible browser command failed.";
}

export function clearVisibleBrowserRendererLease(leaseId: string): void {
  for (const [tabId, tab] of Object.entries(useBrowserPanelStore.getState().tabsById)) {
    if (tab.agentLease?.leaseId === leaseId) {
      useBrowserPanelStore.getState().clearAgentLease(tabId, leaseId);
    }
  }
}

type ResolvedBrowserTab = { readonly tabId: string } | { readonly limitResult: BrowserResult };

function browserTabLimitResult(action: BrowserAction["action"]): BrowserResult {
  const tabsById = useBrowserPanelStore.getState().tabsById;
  const tabs = useRightPanelTabsStore
    .getState()
    .openTabs.filter((tabId) => isRightPanelTabOfKind(tabId, "browser"))
    .map((tabId) => {
      const tab = tabsById[tabId];
      return {
        tabId,
        title: tab?.title ?? "",
        url: tab?.url ?? "",
        openedByAgent: tab?.openedByAgent === true,
      };
    });
  return {
    action,
    summary: `Browser tab limit reached (${MAX_RIGHT_PANEL_BROWSER_TABS}). Ask the user which tab to close before opening another.`,
    target: "visible",
    selectionReason: "tab_limit_reached",
    tabLimit: { limit: MAX_RIGHT_PANEL_BROWSER_TABS, tabs },
  };
}

async function resolveTab(command: VisibleBrowserCommand): Promise<ResolvedBrowserTab> {
  if (command.action.tabId) {
    return { tabId: command.action.tabId };
  }
  const opened = useRightPanelTabsStore.getState().openBrowserTab();
  if (!opened.tabId || opened.status === "limit_reached") {
    return { limitResult: browserTabLimitResult(command.action.action) };
  }
  useBrowserPanelStore.getState().ensureTab(opened.tabId);
  useBrowserPanelStore.getState().markTabOpenedByAgent(opened.tabId);
  return { tabId: opened.tabId };
}

async function executeCommand(command: VisibleBrowserCommand) {
  const resolvedTab = await resolveTab(command);
  if ("limitResult" in resolvedTab) return resolvedTab.limitResult;
  const { tabId } = resolvedTab;
  if (command.action.action === "release_tab") {
    useBrowserPanelStore.getState().clearAgentLease(tabId, command.leaseId);
    return { action: command.action.action, summary: "Released visible browser tab.", tabId };
  }
  if (command.action.action === "close_tab") {
    closeBrowserTabsAfterRevocation([tabId as RightPanelTabId]);
    return { action: command.action.action, summary: "Closed visible browser tab.", tabId };
  }
  useBrowserPanelStore.getState().setAgentLease(tabId, {
    leaseId: command.leaseId,
    threadId: command.threadId,
    turnId: command.turnId,
  });
  const cursor = cursorForAction(command.action);
  if (cursor) {
    useBrowserPanelStore.getState().setAgentCursor(tabId, cursor);
  }
  const handler = await waitForBrowserTabAgentHandler(tabId);
  const action = { ...command.action, tabId } as BrowserAction;
  const result = await handler.execute(action);
  return { ...result, tabId, target: "visible" as const };
}

export async function reconcileBrowserLeases(
  rendererId: string,
  browser: Pick<WsRpcClient["browser"], "getLeases" | "revokeLease"> = getWsRpcClient().browser,
) {
  const leases = await browser.getLeases({ rendererId });
  const tabsById = useBrowserPanelStore.getState().tabsById;
  const openTabs = new Set(useRightPanelTabsStore.getState().openTabs);
  const existingLeases = leases.filter(
    (lease) => tabsById[lease.tabId] !== undefined && openTabs.has(lease.tabId as RightPanelTabId),
  );
  useBrowserPanelStore.getState().reconcileAgentLeases(existingLeases);
  await Promise.all(
    leases
      .filter((lease) => !existingLeases.includes(lease))
      .map((lease) =>
        browser.revokeLease({ rendererId, leaseId: lease.leaseId, tabId: lease.tabId }),
      ),
  );
}

function cursorForAction(action: BrowserAction): { readonly x: number; readonly y: number } | null {
  switch (action.action) {
    case "click":
      return { x: action.x, y: action.y };
    case "drag":
      return { x: action.endX, y: action.endY };
    case "scroll":
      return action.x === undefined || action.y === undefined ? null : { x: action.x, y: action.y };
    default:
      return null;
  }
}

export async function executeAndCompleteVisibleBrowserCommand(input: {
  readonly command: VisibleBrowserCommand;
  readonly rendererId: string;
  readonly execute: (command: VisibleBrowserCommand) => Promise<BrowserResult>;
  readonly complete: WsRpcClient["browser"]["completeCommand"];
  readonly reconcile: (rendererId: string) => Promise<void>;
}): Promise<void> {
  let result: BrowserResult;
  try {
    result = await input.execute(input.command);
  } catch (error) {
    clearVisibleBrowserRendererLease(input.command.leaseId);
    try {
      await input.complete({
        commandId: input.command.commandId,
        rendererId: input.rendererId,
        error: messageFromError(error),
      });
    } catch {
      await input.reconcile(input.rendererId).catch(() => undefined);
    }
    return;
  }

  await input
    .complete({ commandId: input.command.commandId, rendererId: input.rendererId, result })
    .catch(() => undefined);
}

export function BrowserAgentControlBridge() {
  const rendererId = useRef(getVisibleBrowserRendererId()).current;

  useEffect(() => {
    if (!window.desktopBridge) {
      return;
    }
    const client = getWsRpcClient();
    void reconcileBrowserLeases(rendererId).catch(() => undefined);
    return client.browser.onCommand(
      rendererId,
      (command) => {
        void executeAndCompleteVisibleBrowserCommand({
          command,
          rendererId,
          execute: executeCommand,
          complete: client.browser.completeCommand,
          reconcile: reconcileBrowserLeases,
        });
      },
      { onResubscribe: () => void reconcileBrowserLeases(rendererId).catch(() => undefined) },
    );
  }, [rendererId]);

  return null;
}

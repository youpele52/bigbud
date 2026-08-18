import type { BrowserWindow } from "electron";
import type { CompactChatLinkHandoff } from "@bigbud/contracts/server/ipc.ts";

interface CompactLinkHandoffCoordinatorOptions {
  readonly getMainWindow: () => BrowserWindow | null;
  readonly openMainWindow: () => BrowserWindow | null;
  readonly menuActionChannel: string;
}

export interface CompactLinkHandoffCoordinator {
  attachMainWindow: (window: BrowserWindow) => void;
  markRendererReady: (window: BrowserWindow) => void;
  request: (handoff: CompactChatLinkHandoff) => void;
}

function showAndFocus(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

export function createCompactLinkHandoffCoordinator(
  options: CompactLinkHandoffCoordinatorOptions,
): CompactLinkHandoffCoordinator {
  let attachedWindow: BrowserWindow | null = null;
  let rendererReady = false;
  let pendingHandoff: CompactChatLinkHandoff | null = null;

  const flush = (): void => {
    const window = attachedWindow;
    const handoff = pendingHandoff;
    if (!window || window.isDestroyed() || !rendererReady || !handoff) return;

    pendingHandoff = null;
    window.webContents.send(options.menuActionChannel, handoff);
  };

  const clearClosedWindow = (window: BrowserWindow): void => {
    if (window !== attachedWindow) return;
    attachedWindow = null;
    rendererReady = false;
    pendingHandoff = null;
  };

  const attachMainWindow = (window: BrowserWindow): void => {
    if (attachedWindow === window) return;

    attachedWindow = window;
    rendererReady = false;
    window.webContents.on("did-start-loading", () => {
      if (attachedWindow === window) rendererReady = false;
    });
    window.once("closed", () => clearClosedWindow(window));
  };

  const request = (handoff: CompactChatLinkHandoff): void => {
    pendingHandoff = handoff;
    const window = options.getMainWindow() ?? options.openMainWindow();
    if (!window) return;
    attachMainWindow(window);
    if (!window.webContents.isLoadingMainFrame()) showAndFocus(window);
    flush();
  };

  return {
    attachMainWindow,
    markRendererReady: (window) => {
      if (attachedWindow === null) attachMainWindow(window);
      if (window !== attachedWindow || window.isDestroyed()) return;
      rendererReady = true;
      showAndFocus(window);
      flush();
    },
    request,
  };
}

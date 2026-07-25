export type BrowserReloadMode = "normal" | "ignoring-cache";

interface DesktopBrowserReloadPlanInput {
  action: string;
  browserOpen: boolean;
  browserVisible: boolean;
}

interface DesktopBrowserReloadPlan {
  reloadMode: BrowserReloadMode | null;
  shouldActivateBrowser: boolean;
}

export function planDesktopBrowserReload({
  action,
  browserOpen,
  browserVisible,
}: DesktopBrowserReloadPlanInput): DesktopBrowserReloadPlan {
  const reloadMode =
    action === "reload-browser"
      ? "normal"
      : action === "reload-browser-ignoring-cache"
        ? "ignoring-cache"
        : null;

  if (!browserOpen || !reloadMode) {
    return {
      reloadMode: null,
      shouldActivateBrowser: false,
    };
  }

  return {
    reloadMode,
    shouldActivateBrowser: !browserVisible,
  };
}

export type DesktopBrowserContextMenuCommand = "close" | "toggle";

export function planDesktopBrowserContextMenu(input: {
  action: string;
  browserVisible: boolean;
  hasUrl: boolean;
}): DesktopBrowserContextMenuCommand | null {
  if (!input.browserVisible || !input.hasUrl) return null;
  if (input.action === "toggle-browser-context-menu") return "toggle";
  if (input.action === "close-browser-context-menu") return "close";
  return null;
}

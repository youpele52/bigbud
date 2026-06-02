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

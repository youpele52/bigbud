import { requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useBrowserPanelStore } from "./browser.store";

export function openBrowserPanel(input: { url?: string } = {}) {
  const nextUrl = input.url?.trim();
  const { setOpen, setUrl } = useBrowserPanelStore.getState();

  if (nextUrl) {
    setUrl(nextUrl);
  }

  requestRightPanel("browser");
  useRightPanelTabsStore.getState().openTab("browser");
  setOpen(true);
}

export function toggleBrowserPanel() {
  const tabState = useRightPanelTabsStore.getState();
  const browserOpen = useBrowserPanelStore.getState().open;
  const browserActive = tabState.activeKind === "browser" && tabState.rightPanelOpen;

  if (!browserOpen || !browserActive) {
    openBrowserPanel();
    return;
  }

  closeBrowserPanel();
}

export function closeBrowserPanel() {
  useRightPanelTabsStore.getState().closeTab("browser");
  requestRightPanel(useRightPanelTabsStore.getState().activeKind);
  useBrowserPanelStore.getState().setOpen(false);
}

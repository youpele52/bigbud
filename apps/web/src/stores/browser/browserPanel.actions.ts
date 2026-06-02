import { closeDiffPanelIfOpen, requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useBrowserPanelStore } from "./browser.store";

export function openBrowserPanel(input: { url?: string } = {}) {
  const nextUrl = input.url?.trim();
  const { setOpen, setUrl } = useBrowserPanelStore.getState();

  if (nextUrl) {
    setUrl(nextUrl);
  }

  requestRightPanel("browser");
  closeDiffPanelIfOpen();
  useRightPanelTabsStore.getState().openTab("browser");
  setOpen(true);
}

export function toggleBrowserPanel() {
  if (!useBrowserPanelStore.getState().open) {
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

import { closeDiffPanelIfOpen, requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useFilesPanelStore } from "../files/filesPanel.store";
import { useBrowserPanelStore } from "./browser.store";

export function openBrowserPanel(input: { url?: string } = {}) {
  const nextUrl = input.url?.trim();
  const { setOpen, setUrl } = useBrowserPanelStore.getState();

  if (nextUrl) {
    setUrl(nextUrl);
  }

  requestRightPanel("browser");
  closeDiffPanelIfOpen();
  useFilesPanelStore.getState().setOpen(false);
  setOpen(true);
}

export function toggleBrowserPanel() {
  const { open, setOpen } = useBrowserPanelStore.getState();

  if (!open) {
    requestRightPanel("browser");
    closeDiffPanelIfOpen();
    useFilesPanelStore.getState().setOpen(false);
  } else if (useBrowserPanelStore.getState().open) {
    requestRightPanel(null);
  }

  setOpen(!open);
}

export function closeBrowserPanel() {
  if (useBrowserPanelStore.getState().open) {
    requestRightPanel(null);
  }
  useBrowserPanelStore.getState().setOpen(false);
}

import { useBrowserPanelStore } from "./browser.store";

let closeDiffPanel: (() => void) | null = null;
let requestedRightPanel: "browser" | "diff" | null = null;

export function registerDiffPanelCloseAction(callback: (() => void) | null) {
  closeDiffPanel = callback;

  return () => {
    if (closeDiffPanel === callback) {
      closeDiffPanel = null;
    }
  };
}

export function closeDiffPanelIfOpen() {
  closeDiffPanel?.();
}

export function requestRightPanel(panel: "browser" | "diff" | null) {
  requestedRightPanel = panel;
}

export function getRequestedRightPanel() {
  return requestedRightPanel;
}

export function openBrowserPanel(input: { url?: string } = {}) {
  const nextUrl = input.url?.trim();
  const { setOpen, setUrl } = useBrowserPanelStore.getState();

  if (nextUrl) {
    setUrl(nextUrl);
  }

  requestRightPanel("browser");
  closeDiffPanelIfOpen();
  setOpen(true);
}

export function toggleBrowserPanel() {
  const { open, setOpen } = useBrowserPanelStore.getState();

  if (!open) {
    requestRightPanel("browser");
    closeDiffPanelIfOpen();
  } else if (requestedRightPanel === "browser") {
    requestRightPanel(null);
  }

  setOpen(!open);
}

export function closeBrowserPanel() {
  if (requestedRightPanel === "browser") {
    requestRightPanel(null);
  }
  useBrowserPanelStore.getState().setOpen(false);
}

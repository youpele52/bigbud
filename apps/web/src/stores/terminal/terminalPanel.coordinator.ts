import { closeDiffPanelIfOpen, requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useBrowserPanelStore } from "../browser/browser.store";
import { useFilesPanelStore } from "../files/filesPanel.store";
import { useTerminalPanelStore } from "./terminalPanel.store";

export function toggleTerminalPanel() {
  const { open, setOpen } = useTerminalPanelStore.getState();

  if (!open) {
    requestRightPanel("terminal");
    closeDiffPanelIfOpen();
    useBrowserPanelStore.getState().setOpen(false);
    useFilesPanelStore.getState().setOpen(false);
  } else if (useTerminalPanelStore.getState().open) {
    requestRightPanel(null);
  }

  setOpen(!open);
}

export function openTerminalPanel() {
  requestRightPanel("terminal");
  closeDiffPanelIfOpen();
  useBrowserPanelStore.getState().setOpen(false);
  useFilesPanelStore.getState().setOpen(false);
  useTerminalPanelStore.getState().setOpen(true);
}

export function closeTerminalPanel() {
  if (useTerminalPanelStore.getState().open) {
    requestRightPanel(null);
  }
  useTerminalPanelStore.getState().setOpen(false);
}

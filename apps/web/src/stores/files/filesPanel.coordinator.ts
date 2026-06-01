import { closeDiffPanelIfOpen, requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useFilesPanelStore } from "./filesPanel.store";
import { useBrowserPanelStore } from "../browser/browser.store";

export function toggleFilesPanel() {
  const { open, setOpen } = useFilesPanelStore.getState();

  if (!open) {
    requestRightPanel("files");
    closeDiffPanelIfOpen();
    useBrowserPanelStore.getState().setOpen(false);
  } else if (useFilesPanelStore.getState().open) {
    requestRightPanel(null);
  }

  setOpen(!open);
}

export function closeFilesPanel() {
  if (useFilesPanelStore.getState().open) {
    requestRightPanel(null);
  }
  useFilesPanelStore.getState().setOpen(false);
}

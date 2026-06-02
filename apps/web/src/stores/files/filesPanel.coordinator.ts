import { closeDiffPanelIfOpen, requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useFilesPanelStore } from "./filesPanel.store";

export function openFilesPanel() {
  requestRightPanel("files");
  closeDiffPanelIfOpen();
  useRightPanelTabsStore.getState().openTab("files");
  useFilesPanelStore.getState().setOpen(true);
}

export function toggleFilesPanel() {
  if (!useFilesPanelStore.getState().open) {
    openFilesPanel();
    return;
  }

  closeFilesPanel();
}

export function closeFilesPanel() {
  useRightPanelTabsStore.getState().closeTab("files");
  requestRightPanel(useRightPanelTabsStore.getState().activeKind);
  useFilesPanelStore.getState().setOpen(false);
}

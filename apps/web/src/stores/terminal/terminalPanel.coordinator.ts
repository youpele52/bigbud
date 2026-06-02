import { closeDiffPanelIfOpen, requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useTerminalPanelStore } from "./terminalPanel.store";

export function toggleTerminalPanel() {
  if (!useTerminalPanelStore.getState().open) {
    openTerminalPanel();
    return;
  }

  closeTerminalPanel();
}

export function openTerminalPanel() {
  requestRightPanel("terminal");
  closeDiffPanelIfOpen();
  useRightPanelTabsStore.getState().openTab("terminal");
  useTerminalPanelStore.getState().setOpen(true);
}

export function closeTerminalPanel() {
  useRightPanelTabsStore.getState().closeTab("terminal");
  requestRightPanel(useRightPanelTabsStore.getState().activeKind);
  useTerminalPanelStore.getState().setOpen(false);
}

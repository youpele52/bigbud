import { requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useTerminalPanelStore } from "./terminalPanel.store";

export function toggleTerminalPanel() {
  const tabState = useRightPanelTabsStore.getState();
  const terminalOpen = useTerminalPanelStore.getState().open;
  const terminalActive = tabState.activeKind === "terminal" && tabState.rightPanelOpen;

  if (!terminalOpen || !terminalActive) {
    openTerminalPanel();
    return;
  }

  closeTerminalPanel();
}

export function openTerminalPanel() {
  requestRightPanel("terminal");
  useRightPanelTabsStore.getState().openTab("terminal");
  useTerminalPanelStore.getState().setOpen(true);
}

export function closeTerminalPanel() {
  useRightPanelTabsStore.getState().closeTab("terminal");
  requestRightPanel(useRightPanelTabsStore.getState().activeKind);
  useTerminalPanelStore.getState().setOpen(false);
}

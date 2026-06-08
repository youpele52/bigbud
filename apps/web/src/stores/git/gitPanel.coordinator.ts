import { requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";

export function toggleGitPanel() {
  const tabState = useRightPanelTabsStore.getState();
  const gitActive = tabState.activeKind === "git" && tabState.rightPanelOpen;

  if (!gitActive) {
    openGitPanel();
    return;
  }

  closeGitPanel();
}

export function openGitPanel() {
  requestRightPanel("git");
  useRightPanelTabsStore.getState().openTab("git");
}

export function closeGitPanel() {
  useRightPanelTabsStore.getState().closeTab("git");
  requestRightPanel(useRightPanelTabsStore.getState().activeKind);
}

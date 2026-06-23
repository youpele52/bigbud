import { requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useKanbanPanelStore } from "./kanbanPanel.store";

export function openKanbanPanel() {
  requestRightPanel("kanban");
  useRightPanelTabsStore.getState().openTab("kanban");
  useKanbanPanelStore.getState().setOpen(true);
}

export function toggleKanbanPanel() {
  const tabState = useRightPanelTabsStore.getState();
  const kanbanOpen = useKanbanPanelStore.getState().open;
  const kanbanActive = tabState.activeKind === "kanban" && tabState.rightPanelOpen;

  if (!kanbanOpen || !kanbanActive) {
    openKanbanPanel();
    return;
  }

  closeKanbanPanel();
}

export function closeKanbanPanel() {
  useRightPanelTabsStore.getState().closeTab("kanban");
  requestRightPanel(useRightPanelTabsStore.getState().activeKind);
  useKanbanPanelStore.getState().setOpen(false);
  useKanbanPanelStore.getState().setSelectedCardId(null);
  useKanbanPanelStore.getState().setPreviewMode(false);
}

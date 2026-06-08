import { requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useNotesPanelStore } from "./notesPanel.store";

export function openNotesPanel() {
  requestRightPanel("notes");
  useRightPanelTabsStore.getState().openTab("notes");
  useNotesPanelStore.getState().setOpen(true);
}

export function toggleNotesPanel() {
  const tabState = useRightPanelTabsStore.getState();
  const notesOpen = useNotesPanelStore.getState().open;
  const notesActive = tabState.activeKind === "notes" && tabState.rightPanelOpen;

  if (!notesOpen || !notesActive) {
    openNotesPanel();
    return;
  }

  closeNotesPanel();
}

export function closeNotesPanel() {
  useRightPanelTabsStore.getState().closeTab("notes");
  requestRightPanel(useRightPanelTabsStore.getState().activeKind);
  useNotesPanelStore.getState().setOpen(false);
  useNotesPanelStore.getState().setSelectedNoteId(null);
  useNotesPanelStore.getState().setPreviewMode(true);
}

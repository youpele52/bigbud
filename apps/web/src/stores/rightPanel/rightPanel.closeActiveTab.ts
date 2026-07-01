import { closeBrowserTab } from "~/stores/browser/browserPanel.actions";
import { closeFilesPanel } from "~/stores/files/filesPanel.coordinator";
import { closeGitPanel } from "~/stores/git/gitPanel.coordinator";
import { closeKanbanPanel } from "~/stores/kanban/kanbanPanel.coordinator";
import { closeNotesPanel } from "~/stores/notes/notesPanel.coordinator";
import { closeTerminalPanel } from "~/stores/terminal/terminalPanel.coordinator";

import { closeDiffPanelIfOpen } from "./rightPanel.coordinator";
import {
  getRightPanelTabKind,
  useRightPanelTabsStore,
  type RightPanelTabId,
} from "./rightPanelTabs.store";

export function closeActiveRightPanelTab(): boolean {
  const state = useRightPanelTabsStore.getState();
  if (!state.rightPanelOpen || state.activeTabId === null) {
    return false;
  }

  closeRightPanelTabById(state.activeTabId);
  return true;
}

export function closeRightPanelTabById(tabId: RightPanelTabId): void {
  switch (getRightPanelTabKind(tabId)) {
    case "browser":
      closeBrowserTab(tabId);
      return;
    case "diff":
      closeDiffPanelIfOpen();
      return;
    case "files":
      closeFilesPanel();
      return;
    case "git":
      closeGitPanel();
      return;
    case "kanban":
      closeKanbanPanel();
      return;
    case "notes":
      closeNotesPanel();
      return;
    case "terminal":
      closeTerminalPanel();
      return;
  }
}

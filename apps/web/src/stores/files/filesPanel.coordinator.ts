import { requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useFilesPanelStore } from "./filesPanel.store";

export function openFilesPanel() {
  requestRightPanel("files");
  useRightPanelTabsStore.getState().openTab("files");
  useFilesPanelStore.getState().setOpen(true);
}

export function openFileInFilesPanel(
  relativePath: string,
  previewPosition?: { line: number; column: number | null } | null,
  workspaceRootOverride: string | null = null,
) {
  openFilesPanel();
  useFilesPanelStore
    .getState()
    .requestFileOpen(relativePath, previewPosition ?? null, workspaceRootOverride);
}

export function openDirectoryInFilesPanel(
  relativePath: string,
  workspaceRootOverride: string | null = null,
) {
  openFilesPanel();
  useFilesPanelStore.getState().setPreviewPath(null);
  useFilesPanelStore.getState().setPreviewPosition(null);
  useFilesPanelStore.getState().requestDirectoryNavigation(relativePath, workspaceRootOverride);
}

export function toggleFilesPanel() {
  const tabState = useRightPanelTabsStore.getState();
  const filesOpen = useFilesPanelStore.getState().open;
  const filesActive = tabState.activeKind === "files" && tabState.rightPanelOpen;

  if (!filesOpen || !filesActive) {
    openFilesPanel();
    return;
  }

  closeFilesPanel();
}

export function closeFilesPanel() {
  useRightPanelTabsStore.getState().closeTab("files");
  requestRightPanel(useRightPanelTabsStore.getState().activeKind);
  useFilesPanelStore.getState().setOpen(false);
  useFilesPanelStore.getState().setWorkspaceRootOverride(null);
  useFilesPanelStore.getState().setPreviewPath(null);
  useFilesPanelStore.getState().setPreviewPosition(null);
}

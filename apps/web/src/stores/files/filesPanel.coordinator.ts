import type { ExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import { requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useFilesPanelStore } from "./filesPanel.store";

export function openFilesPanel() {
  requestRightPanel("files");
  useRightPanelTabsStore.getState().openTab("files");
  useFilesPanelStore.getState().setOpen(true);
}

/**
 * Low-level: `relativePath` is relative to `workspaceRoot`, which is always named explicitly.
 * Prefer `filesPanel.open.ts`, which takes absolute paths.
 */
export function openFileInFilesPanel(
  relativePath: string,
  previewPosition: { line: number; column: number | null } | null,
  workspaceRoot: string,
  workspaceExecutionTargetIdOverride?: ExecutionTargetId | null,
) {
  openFilesPanel();
  useFilesPanelStore
    .getState()
    .requestFileOpen(
      relativePath,
      previewPosition,
      workspaceRoot,
      workspaceExecutionTargetIdOverride,
    );
}

export function openDirectoryInFilesPanel(
  relativePath: string,
  workspaceRoot: string,
  workspaceExecutionTargetIdOverride?: ExecutionTargetId | null,
) {
  openFilesPanel();
  useFilesPanelStore.getState().setPreviewPath(null);
  useFilesPanelStore.getState().setPreviewPosition(null);
  useFilesPanelStore
    .getState()
    .requestDirectoryNavigation(relativePath, workspaceRoot, workspaceExecutionTargetIdOverride);
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
  useFilesPanelStore.setState({ workspaceExecutionTargetIdOverride: null });
  useFilesPanelStore.getState().setPreviewPath(null);
  useFilesPanelStore.getState().setPreviewPosition(null);
}

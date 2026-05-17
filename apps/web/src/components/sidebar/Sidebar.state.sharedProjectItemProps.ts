import type { ThreadId } from "@bigbud/contracts";

import type { ThreadPr } from "./SidebarThreadRow";
import type { SharedProjectItemProps } from "./Sidebar.types";
import type { SidebarRenderedProjectsOutput } from "./Sidebar.renderedProjects";
import type { SidebarProjectActionsOutput } from "./Sidebar.projectActions";
import type { SidebarThreadActionsOutput } from "./Sidebar.threadActions.types";

interface BuildSharedProjectItemPropsInput {
  readonly isManualProjectSorting: boolean;
  readonly newThreadShortcutLabel: string | null | undefined;
  readonly showThreadJumpHints: boolean;
  readonly threadJumpLabelById: Map<ThreadId, string>;
  readonly appSettingsDefaultThreadEnvMode: "local" | "worktree";
  readonly routeThreadId: ThreadId | null;
  readonly threadActions: SidebarThreadActionsOutput;
  readonly activeThread: SharedProjectItemProps["activeThread"];
  readonly activeDraftThread: SharedProjectItemProps["activeDraftThread"];
  readonly projectActions: SidebarProjectActionsOutput;
  readonly favoriteThreadIds: ReadonlySet<ThreadId>;
  readonly prByThreadId: Map<ThreadId, ThreadPr>;
  readonly handleNewThread: SharedProjectItemProps["handleNewThread"];
  readonly renderedProjectsState: Pick<
    SidebarRenderedProjectsOutput,
    "attachThreadListAutoAnimateRef" | "expandThreadListForProject" | "collapseThreadListForProject"
  >;
}

export function buildSharedProjectItemProps(
  input: BuildSharedProjectItemPropsInput,
): SharedProjectItemProps {
  return {
    isManualProjectSorting: input.isManualProjectSorting,
    newThreadShortcutLabel: input.newThreadShortcutLabel,
    showThreadJumpHints: input.showThreadJumpHints,
    threadJumpLabelById: input.threadJumpLabelById,
    appSettingsDefaultThreadEnvMode: input.appSettingsDefaultThreadEnvMode,
    routeThreadId: input.routeThreadId,
    selectedThreadIds: input.threadActions.selectedThreadIds,
    renamingThreadId: input.threadActions.renamingThreadId,
    renamingTitle: input.threadActions.renamingTitle,
    setRenamingTitle: input.threadActions.setRenamingTitle,
    onRenamingInputMount: input.threadActions.onRenamingInputMount,
    hasRenameCommitted: input.threadActions.hasRenameCommitted,
    markRenameCommitted: input.threadActions.markRenameCommitted,
    favoriteThreadIds: input.favoriteThreadIds,
    toggleFavoriteThread: input.threadActions.toggleFavoriteThread,
    activeThread: input.activeThread,
    activeDraftThread: input.activeDraftThread,
    renamingProjectId: input.projectActions.renamingProjectId,
    renamingProjectTitle: input.projectActions.renamingProjectTitle,
    setRenamingProjectTitle: input.projectActions.setRenamingProjectTitle,
    onProjectRenamingInputMount: input.projectActions.onProjectRenamingInputMount,
    hasProjectRenameCommitted: input.projectActions.hasProjectRenameCommitted,
    markProjectRenameCommitted: input.projectActions.markProjectRenameCommitted,
    commitProjectRename: input.projectActions.commitProjectRename,
    cancelProjectRename: input.projectActions.cancelProjectRename,
    requestProjectDelete: input.projectActions.requestProjectDelete,
    attachThreadListAutoAnimateRef: input.renderedProjectsState.attachThreadListAutoAnimateRef,
    handleProjectTitlePointerDownCapture: input.projectActions.handleProjectTitlePointerDownCapture,
    handleProjectTitleClick: input.projectActions.handleProjectTitleClick,
    handleProjectTitleKeyDown: input.projectActions.handleProjectTitleKeyDown,
    handleProjectContextMenu: input.projectActions.handleProjectContextMenu,
    handleThreadClick: input.threadActions.handleThreadClick,
    navigateToThread: input.threadActions.navigateToThread,
    handleMultiSelectContextMenu: input.threadActions.handleMultiSelectContextMenu,
    handleThreadContextMenu: input.threadActions.handleThreadContextMenu,
    clearSelection: input.threadActions.clearSelection,
    commitRename: input.threadActions.commitRename,
    cancelRename: input.threadActions.cancelRename,
    forkThread: input.threadActions.forkThread,
    requestThreadDelete: input.threadActions.requestThreadDelete,
    openPrLink: input.threadActions.openPrLink,
    prByThreadId: input.prByThreadId,
    handleNewThread: input.handleNewThread,
    expandThreadListForProject: input.renderedProjectsState.expandThreadListForProject,
    collapseThreadListForProject: input.renderedProjectsState.collapseThreadListForProject,
  };
}

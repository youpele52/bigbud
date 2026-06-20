import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  GripVerticalIcon,
  ServerIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import { SIDEBAR_COMPACT_ICON_SIZE_CLASS, SIDEBAR_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { useCallback, type MouseEvent } from "react";

import {
  getHiddenSidebarThreadCount,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarNewThreadSeedContext,
} from "./Sidebar.logic";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { getProjectRemoteTargetLabel, isRemoteExecutionTargetId } from "./Sidebar.projects.logic";
import { SidebarMenuButton, SidebarMenuAction } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSwipeRevealAction } from "./useSwipeRevealAction";
import { SidebarRenderedProjectItemThreadList } from "./SidebarRenderedProjectItem.thread-list";
import {
  isChatsSidebarProject,
  type SidebarRenderedProjectItemProps,
} from "./SidebarRenderedProjectItem.types";

export function SidebarRenderedProjectItem({
  dragHandleProps,
  isManualProjectSorting,
  orderedProjectThreadIds,
  project,
  projectStatus,
  renderedThreadIds,
  hasHiddenThreads,
  showEmptyThreadState,
  shouldShowThreadPanel,
  isThreadListExpanded,

  newThreadShortcutLabel,
  showThreadJumpHints,
  threadJumpLabelById,
  appSettingsDefaultThreadEnvMode,
  routeThreadId,
  selectedThreadIds,
  renamingThreadId,
  renamingTitle,
  setRenamingTitle,
  onRenamingInputMount,
  hasRenameCommitted,
  markRenameCommitted,
  favoriteThreadIds,
  automationThreadIds,
  toggleFavoriteThread,
  activeThread,
  activeDraftThread,
  renamingProjectId,
  renamingProjectTitle,
  setRenamingProjectTitle,
  onProjectRenamingInputMount,
  hasProjectRenameCommitted,
  markProjectRenameCommitted,
  commitProjectRename,
  cancelProjectRename,
  requestProjectDelete,
  attachThreadListAutoAnimateRef,
  handleProjectTitlePointerDownCapture,
  handleProjectTitleClick,
  handleProjectTitleKeyDown,
  handleProjectContextMenu,
  handleThreadClick,
  navigateToThread,
  handleMultiSelectContextMenu,
  handleThreadContextMenu,
  clearSelection,
  commitRename,
  cancelRename,
  branchThread,
  requestThreadDelete,
  openPrLink,
  prByThreadId,
  handleNewThread,
  expandThreadListForProject,
  collapseThreadListForProject,
}: SidebarRenderedProjectItemProps) {
  const isChatsProject = isChatsSidebarProject(project.id);
  const workspaceExecutionTargetId = resolveWorkspaceExecutionTargetId(project);
  const isRemoteProject = isRemoteExecutionTargetId(workspaceExecutionTargetId);
  const remoteTargetLabel = getProjectRemoteTargetLabel(workspaceExecutionTargetId);
  const swipeReveal = useSwipeRevealAction<HTMLButtonElement>({
    itemId: project.id,
    disabled: renamingProjectId === project.id || isChatsProject,
  });

  const visibleThreadIds = renderedThreadIds;
  const hiddenThreadCount = getHiddenSidebarThreadCount({
    totalThreadCount: orderedProjectThreadIds.length,
    renderedThreadCount: renderedThreadIds.length,
  });

  const handleProjectDeleteAction = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      swipeReveal.clearGestureClickSuppression();
      swipeReveal.resetReveal();
      requestProjectDelete(project.id);
    },
    [project.id, requestProjectDelete, swipeReveal],
  );

  return (
    <>
      <div className="group/project-header relative">
        <div
          ref={swipeReveal.registerBoundaryElement}
          className="relative overflow-hidden rounded-md"
        >
          <div
            className={`absolute inset-y-0 right-0 flex w-11 items-center justify-center transition-opacity duration-150 ${
              swipeReveal.isActionVisible
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0"
            }`}
          >
            <button
              type="button"
              data-thread-selection-safe
              aria-label={`Remove project ${project.name}`}
              aria-hidden={!swipeReveal.isActionVisible}
              tabIndex={swipeReveal.isActionVisible ? 0 : -1}
              className="inline-flex size-8 items-center justify-center rounded-md text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={handleProjectDeleteAction}
            >
              <Trash2Icon className={SIDEBAR_COMPACT_ICON_SIZE_CLASS} />
            </button>
          </div>
          <SidebarMenuButton
            render={<div />}
            size="sm"
            className={`gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground ${
              swipeReveal.isDragging
                ? "transition-none"
                : "transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
            }`}
            style={{ transform: `translateX(${swipeReveal.revealOffset}px)` }}
          >
            {isManualProjectSorting && dragHandleProps ? (
              <button
                ref={dragHandleProps.setActivatorNodeRef}
                type="button"
                aria-label={`Reorder project ${project.name}`}
                className="inline-flex size-3.5 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:text-foreground active:cursor-grabbing"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
                {...dragHandleProps.attributes}
                {...dragHandleProps.listeners}
              >
                <GripVerticalIcon className={SIDEBAR_COMPACT_ICON_SIZE_CLASS} />
              </button>
            ) : null}
            <button
              type="button"
              className="flex min-w-0 flex-1 touch-pan-y items-center gap-2 text-left"
              onPointerDownCapture={handleProjectTitlePointerDownCapture}
              onPointerDown={swipeReveal.handlePointerDown}
              onPointerMove={swipeReveal.handlePointerMove}
              onPointerUp={swipeReveal.handlePointerUp}
              onPointerCancel={swipeReveal.handlePointerCancel}
              onWheel={swipeReveal.handleWheel}
              onClick={(event) => {
                if (swipeReveal.consumeGestureClickSuppression()) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                if (swipeReveal.isRevealed) {
                  event.preventDefault();
                  event.stopPropagation();
                  swipeReveal.resetReveal();
                  return;
                }
                handleProjectTitleClick(event, project.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && swipeReveal.isRevealed) {
                  event.preventDefault();
                  swipeReveal.resetReveal();
                  return;
                }
                handleProjectTitleKeyDown(event, project.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                swipeReveal.resetReveal();
                handleProjectContextMenu(project.id, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              {project.expanded ? (
                <FolderOpenIcon
                  className={`${SIDEBAR_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/70`}
                />
              ) : (
                <FolderIcon
                  className={`${SIDEBAR_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/70`}
                />
              )}
              {renamingProjectId === project.id ? (
                <input
                  ref={onProjectRenamingInputMount}
                  className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-xs font-medium text-foreground/90 outline-none"
                  value={renamingProjectTitle}
                  onChange={(event) => setRenamingProjectTitle(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      markProjectRenameCommitted();
                      void commitProjectRename(project.id, renamingProjectTitle, project.name);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      markProjectRenameCommitted();
                      cancelProjectRename();
                    }
                  }}
                  onBlur={() => {
                    if (!hasProjectRenameCommitted()) {
                      markProjectRenameCommitted();
                      void commitProjectRename(project.id, renamingProjectTitle, project.name);
                    }
                  }}
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                />
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-foreground/90">
                    {project.name}
                  </span>
                  {isRemoteProject ? (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border/70 bg-secondary/70 px-1 py-0.5 text-[9px] font-medium tracking-[0.12em] text-muted-foreground/80 uppercase"
                      title={remoteTargetLabel ?? "SSH remote project"}
                    >
                      <ServerIcon className="size-2.5" />
                      SSH
                    </span>
                  ) : null}
                  {project.expanded ? (
                    <ChevronRightIcon
                      className={`${SIDEBAR_ICON_SIZE_CLASS} shrink-0 rotate-90 text-muted-foreground/70 transition-all duration-150`}
                    />
                  ) : projectStatus ? (
                    <span
                      aria-hidden="true"
                      title={projectStatus.label}
                      className={`relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
                    >
                      <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                        <span
                          className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                            projectStatus.pulse ? "animate-pulse" : ""
                          }`}
                        />
                      </span>
                      <ChevronRightIcon
                        className={`absolute inset-0 m-auto ${SIDEBAR_ICON_SIZE_CLASS} translate-x-1 text-muted-foreground/70 opacity-0 transition-all duration-150 group-hover/project-header:translate-x-0 group-hover/project-header:opacity-100`}
                      />
                    </span>
                  ) : (
                    <ChevronRightIcon
                      className={`${SIDEBAR_ICON_SIZE_CLASS} shrink-0 translate-x-1 text-muted-foreground/70 opacity-0 transition-all duration-150 group-hover/project-header:translate-x-0 group-hover/project-header:opacity-100`}
                    />
                  )}
                </span>
              )}
            </button>
          </SidebarMenuButton>
        </div>
        {!swipeReveal.isActionVisible && !isChatsProject ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuAction
                  render={
                    <button
                      type="button"
                      aria-label={`Create new thread in ${project.name}`}
                      data-testid="new-thread-button"
                    />
                  }
                  showOnHover
                  className="top-1 right-1.5 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const seedContext = resolveSidebarNewThreadSeedContext({
                      projectId: project.id,
                      defaultEnvMode: resolveSidebarNewThreadEnvMode({
                        defaultEnvMode: appSettingsDefaultThreadEnvMode,
                      }),
                      activeThread:
                        activeThread && activeThread.projectId === project.id
                          ? {
                              projectId: activeThread.projectId,
                              branch: activeThread.branch,
                              worktreePath: activeThread.worktreePath,
                            }
                          : null,
                      activeDraftThread:
                        activeDraftThread && activeDraftThread.projectId === project.id
                          ? {
                              projectId: activeDraftThread.projectId,
                              branch: activeDraftThread.branch,
                              worktreePath: activeDraftThread.worktreePath,
                              envMode: activeDraftThread.envMode,
                            }
                          : null,
                    });
                    void handleNewThread(project.id, {
                      ...(seedContext.branch !== undefined ? { branch: seedContext.branch } : {}),
                      ...(seedContext.worktreePath !== undefined
                        ? { worktreePath: seedContext.worktreePath }
                        : {}),
                      envMode: seedContext.envMode,
                    });
                  }}
                >
                  <SquarePenIcon className={SIDEBAR_COMPACT_ICON_SIZE_CLASS} />
                </SidebarMenuAction>
              }
            />
            <TooltipPopup side="top">
              {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>

      <SidebarRenderedProjectItemThreadList
        projectId={project.id}
        orderedProjectThreadIds={orderedProjectThreadIds}
        visibleThreadIds={visibleThreadIds}
        routeThreadId={routeThreadId}
        selectedThreadIds={selectedThreadIds}
        showThreadJumpHints={showThreadJumpHints}
        threadJumpLabelById={threadJumpLabelById}
        renamingThreadId={renamingThreadId}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        onRenamingInputMount={onRenamingInputMount}
        hasRenameCommitted={hasRenameCommitted}
        markRenameCommitted={markRenameCommitted}
        handleThreadClick={handleThreadClick}
        navigateToThread={navigateToThread}
        handleMultiSelectContextMenu={handleMultiSelectContextMenu}
        handleThreadContextMenu={handleThreadContextMenu}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        branchThread={branchThread}
        favoriteThreadIds={favoriteThreadIds}
        automationThreadIds={automationThreadIds}
        toggleFavoriteThread={toggleFavoriteThread}
        requestThreadDelete={requestThreadDelete}
        openPrLink={openPrLink}
        prByThreadId={prByThreadId}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        shouldShowThreadPanel={shouldShowThreadPanel}
        showEmptyThreadState={showEmptyThreadState}
        hasHiddenThreads={hasHiddenThreads}
        isThreadListExpanded={isThreadListExpanded}
        hiddenThreadCount={hiddenThreadCount}
        expandThreadListForProject={expandThreadListForProject}
        collapseThreadListForProject={collapseThreadListForProject}
        projectExpanded={project.expanded}
      />
    </>
  );
}

import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  GripVerticalIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import {
  useCallback,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type SetStateAction,
} from "react";
import { isBuiltInChatsProject, type ProjectId, type ThreadId } from "@bigbud/contracts";

import {
  getHiddenSidebarThreadCount,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarNewThreadSeedContext,
  resolveThreadStatusPill,
  type SidebarNewThreadEnvMode,
} from "./Sidebar.logic";
import type { SortableProjectHandleProps } from "./SidebarProjectItem";
import { SidebarThreadRow, type ThreadPr } from "./SidebarThreadRow";
import {
  SidebarMenuButton,
  SidebarMenuAction,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSwipeRevealAction } from "./useSwipeRevealAction";

type ProjectStatusIndicator = NonNullable<ReturnType<typeof resolveThreadStatusPill>>;

const SIDEBAR_PROJECT_ICON_SIZE = "size-4";

export interface RenderedProjectData {
  hasHiddenThreads: boolean;
  hiddenThreadStatus: ProjectStatusIndicator | null;
  orderedProjectThreadIds: readonly ThreadId[];
  project: {
    id: ProjectId;
    name: string;
    cwd: string;
    expanded: boolean;
  };
  projectStatus: ProjectStatusIndicator | null;
  renderedThreadIds: readonly ThreadId[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
}

export interface SidebarRenderedProjectItemProps extends RenderedProjectData {
  dragHandleProps: SortableProjectHandleProps | null;
  isManualProjectSorting: boolean;
  newThreadShortcutLabel: string | null | undefined;
  showThreadJumpHints: boolean;
  threadJumpLabelById: Map<ThreadId, string>;
  appSettingsConfirmThreadArchive: boolean;
  appSettingsDefaultThreadEnvMode: SidebarNewThreadEnvMode;
  routeThreadId: ThreadId | null;
  selectedThreadIds: ReadonlySet<ThreadId>;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  /** Callback ref for the rename input element — handles focus/select on mount. */
  onRenamingInputMount: (element: HTMLInputElement | null) => void;
  /** Returns whether the rename has already been committed. */
  hasRenameCommitted: () => boolean;
  /** Marks the rename as committed to prevent double-commit on blur. */
  markRenameCommitted: () => void;
  confirmingArchiveThreadId: ThreadId | null;
  setConfirmingArchiveThreadId: Dispatch<SetStateAction<ThreadId | null>>;
  confirmArchiveButtonRefs: MutableRefObject<Map<ThreadId, HTMLButtonElement>>;
  activeThread: {
    projectId: ProjectId;
    branch: string | null;
    worktreePath: string | null;
  } | null;
  activeDraftThread: {
    projectId: ProjectId;
    branch: string | null;
    worktreePath: string | null;
    envMode: SidebarNewThreadEnvMode;
  } | null;
  // Project rename
  renamingProjectId: ProjectId | null;
  renamingProjectTitle: string;
  setRenamingProjectTitle: (title: string) => void;
  /** Callback ref for the rename input element — handles focus/select on mount. */
  onProjectRenamingInputMount: (element: HTMLInputElement | null) => void;
  /** Returns whether the project rename has already been committed. */
  hasProjectRenameCommitted: () => boolean;
  /** Marks the project rename as committed to prevent double-commit on blur. */
  markProjectRenameCommitted: () => void;
  commitProjectRename: (
    projectId: ProjectId,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelProjectRename: () => void;
  requestProjectDelete: (projectId: ProjectId) => void;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  handleProjectTitlePointerDownCapture: (event: PointerEvent<HTMLButtonElement>) => void;
  handleProjectTitleClick: (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => void;
  handleProjectTitleKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    projectId: ProjectId,
  ) => void;
  handleProjectContextMenu: (projectId: ProjectId, position: { x: number; y: number }) => void;
  handleThreadClick: (
    event: MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
  ) => void;
  navigateToThread: (threadId: ThreadId) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  forkThread: (threadId: ThreadId) => Promise<void>;
  requestThreadDelete: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  prByThreadId: Map<ThreadId, ThreadPr>;
  handleNewThread: (
    projectId: ProjectId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: SidebarNewThreadEnvMode;
    },
  ) => Promise<void>;
  expandThreadListForProject: (projectId: ProjectId) => void;
  collapseThreadListForProject: (projectId: ProjectId) => void;
}

/** Renders a single project entry (header + thread list) in the sidebar project list. */
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
  appSettingsConfirmThreadArchive,
  appSettingsDefaultThreadEnvMode,
  routeThreadId,
  selectedThreadIds,
  renamingThreadId,
  renamingTitle,
  setRenamingTitle,
  onRenamingInputMount,
  hasRenameCommitted,
  markRenameCommitted,
  confirmingArchiveThreadId,
  setConfirmingArchiveThreadId,
  confirmArchiveButtonRefs,
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
  attemptArchiveThread,
  forkThread,
  requestThreadDelete,
  openPrLink,
  prByThreadId,
  handleNewThread,
  expandThreadListForProject,
  collapseThreadListForProject,
}: SidebarRenderedProjectItemProps) {
  const isChatsProject = isBuiltInChatsProject(project.id);
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
              <Trash2Icon className="size-3.5" />
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
                className="inline-flex size-4 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:text-foreground active:cursor-grabbing"
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
                <GripVerticalIcon className="size-3.5" />
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
              {!project.expanded && projectStatus ? (
                <span
                  aria-hidden="true"
                  title={projectStatus.label}
                  className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
                >
                  <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                    <span
                      className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                        projectStatus.pulse ? "animate-pulse" : ""
                      }`}
                    />
                  </span>
                  <ChevronRightIcon
                    className={`absolute inset-0 m-auto ${SIDEBAR_PROJECT_ICON_SIZE} text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100`}
                  />
                </span>
              ) : (
                <ChevronRightIcon
                  className={`-ml-0.5 ${SIDEBAR_PROJECT_ICON_SIZE} shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                    project.expanded ? "rotate-90" : ""
                  }`}
                />
              )}
              {project.expanded ? (
                <FolderOpenIcon
                  className={`${SIDEBAR_PROJECT_ICON_SIZE} shrink-0 text-muted-foreground/70`}
                />
              ) : (
                <FolderIcon
                  className={`${SIDEBAR_PROJECT_ICON_SIZE} shrink-0 text-muted-foreground/70`}
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
                <span className="flex-1 truncate text-xs font-medium text-foreground/90">
                  {project.name}
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
                  <SquarePenIcon className="size-3.5" />
                </SidebarMenuAction>
              }
            />
            <TooltipPopup side="top">
              {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>

      <SidebarMenuSub
        ref={attachThreadListAutoAnimateRef}
        className="my-0 ml-3 mr-1 translate-x-px gap-0.5 overflow-hidden border-l border-sidebar-border pl-6 pr-1 py-0"
      >
        {shouldShowThreadPanel && showEmptyThreadState ? (
          <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
            <div
              data-thread-selection-safe
              className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60"
            >
              <span>No threads yet</span>
            </div>
          </SidebarMenuSubItem>
        ) : null}
        {shouldShowThreadPanel &&
          visibleThreadIds.map((threadId) => (
            <SidebarThreadRow
              key={threadId}
              threadId={threadId}
              orderedProjectThreadIds={orderedProjectThreadIds}
              routeThreadId={routeThreadId}
              selectedThreadIds={selectedThreadIds}
              showThreadJumpHints={showThreadJumpHints}
              jumpLabel={threadJumpLabelById.get(threadId) ?? null}
              appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
              renamingThreadId={renamingThreadId}
              renamingTitle={renamingTitle}
              setRenamingTitle={setRenamingTitle}
              onRenamingInputMount={onRenamingInputMount}
              hasRenameCommitted={hasRenameCommitted}
              markRenameCommitted={markRenameCommitted}
              confirmingArchiveThreadId={confirmingArchiveThreadId}
              setConfirmingArchiveThreadId={setConfirmingArchiveThreadId}
              confirmArchiveButtonRefs={confirmArchiveButtonRefs}
              handleThreadClick={handleThreadClick}
              navigateToThread={navigateToThread}
              handleMultiSelectContextMenu={handleMultiSelectContextMenu}
              handleThreadContextMenu={handleThreadContextMenu}
              clearSelection={clearSelection}
              commitRename={commitRename}
              cancelRename={cancelRename}
              attemptArchiveThread={attemptArchiveThread}
              forkThread={forkThread}
              requestThreadDelete={requestThreadDelete}
              openPrLink={openPrLink}
              pr={prByThreadId.get(threadId) ?? null}
            />
          ))}

        {/* See more / Show less for the shared project-thread preview */}
        {project.expanded && hasHiddenThreads && (
          <SidebarMenuSubItem className="w-full">
            <SidebarMenuSubButton
              render={<button type="button" />}
              data-thread-selection-safe
              size="sm"
              className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
              onClick={() => {
                if (isThreadListExpanded) {
                  collapseThreadListForProject(project.id);
                  return;
                }
                expandThreadListForProject(project.id);
              }}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {isThreadListExpanded ? (
                  <span>Show less</span>
                ) : (
                  <span>{`See more (${hiddenThreadCount})`}</span>
                )}
              </span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        )}
      </SidebarMenuSub>
    </>
  );
}

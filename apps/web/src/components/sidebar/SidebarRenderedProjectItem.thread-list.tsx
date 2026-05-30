import { type ProjectId, type ThreadId } from "@bigbud/contracts";
import { type MouseEvent } from "react";

import { SidebarThreadRow } from "./SidebarThreadRow";
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";

interface SidebarRenderedProjectItemThreadListProps {
  projectId: ProjectId;
  orderedProjectThreadIds: readonly ThreadId[];
  visibleThreadIds: readonly ThreadId[];
  routeThreadId: ThreadId | null;
  selectedThreadIds: ReadonlySet<ThreadId>;
  showThreadJumpHints: boolean;
  threadJumpLabelById: Map<ThreadId, string>;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  onRenamingInputMount: (element: HTMLInputElement | null) => void;
  hasRenameCommitted: () => boolean;
  markRenameCommitted: () => void;
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
  branchThread: (threadId: ThreadId) => Promise<void>;
  favoriteThreadIds: ReadonlySet<ThreadId>;
  toggleFavoriteThread: (threadId: ThreadId) => Promise<void>;
  requestThreadDelete: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  prByThreadId: Map<ThreadId, import("./SidebarThreadRow").ThreadPr>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  shouldShowThreadPanel: boolean;
  showEmptyThreadState: boolean;
  hasHiddenThreads: boolean;
  isThreadListExpanded: boolean;
  hiddenThreadCount: number;
  expandThreadListForProject: (projectId: ProjectId) => void;
  collapseThreadListForProject: (projectId: ProjectId) => void;
  projectExpanded: boolean;
}

export function SidebarRenderedProjectItemThreadList({
  projectId,
  orderedProjectThreadIds,
  visibleThreadIds,
  routeThreadId,
  selectedThreadIds,
  showThreadJumpHints,
  threadJumpLabelById,
  renamingThreadId,
  renamingTitle,
  setRenamingTitle,
  onRenamingInputMount,
  hasRenameCommitted,
  markRenameCommitted,
  handleThreadClick,
  navigateToThread,
  handleMultiSelectContextMenu,
  handleThreadContextMenu,
  clearSelection,
  commitRename,
  cancelRename,
  branchThread,
  favoriteThreadIds,
  toggleFavoriteThread,
  requestThreadDelete,
  openPrLink,
  prByThreadId,
  attachThreadListAutoAnimateRef,
  shouldShowThreadPanel,
  showEmptyThreadState,
  hasHiddenThreads,
  isThreadListExpanded,
  hiddenThreadCount,
  expandThreadListForProject,
  collapseThreadListForProject,
  projectExpanded,
}: SidebarRenderedProjectItemThreadListProps) {
  return (
    <SidebarMenuSub
      ref={attachThreadListAutoAnimateRef}
      className="my-0 ml-2 mr-1 gap-0.5 overflow-hidden pl-3 pr-1 py-0"
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
            toggleFavoriteThread={toggleFavoriteThread}
            requestThreadDelete={requestThreadDelete}
            openPrLink={openPrLink}
            pr={prByThreadId.get(threadId) ?? null}
          />
        ))}

      {projectExpanded && hasHiddenThreads ? (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={<button type="button" />}
            data-thread-selection-safe
            size="sm"
            className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
            onClick={() => {
              if (isThreadListExpanded) {
                collapseThreadListForProject(projectId);
                return;
              }
              expandThreadListForProject(projectId);
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
      ) : null}
    </SidebarMenuSub>
  );
}

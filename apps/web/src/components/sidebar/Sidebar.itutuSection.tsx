import type { ThreadId } from "@bigbud/contracts";
import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { useMemo, useState, type DragEvent } from "react";

import type { Project, SidebarThreadSummary } from "../../models/types/app.types";
import { useItutuStore } from "../../stores/itutu/itutu.store";
import { useStore } from "../../stores/main";
import {
  SidebarGroup,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { moveThreadsToState } from "./Sidebar.itutu.actions";
import { useItutuCatalog } from "./Sidebar.itutu.catalog";
import {
  BIGBUD_ITUTU_THREAD_DRAG_MIME,
  ITUTU_BOTTOM_STATES,
  groupItutuThreadIds,
  organizationStateOf,
  readItutuDragThreadId,
  resolveItutuLocation,
} from "./Sidebar.itutu.logic";
import { SidebarItutuLocationLine } from "./Sidebar.itutuLocation";
import type { SharedProjectItemProps } from "./Sidebar.types";
import { SidebarItutuGroupLabel } from "./Sidebar.itutuGroupLabel";
import { SidebarThreadRow } from "./SidebarThreadRow";

const addItutuDragData = (threadId: ThreadId) => (dataTransfer: DataTransfer) =>
  dataTransfer.setData(BIGBUD_ITUTU_THREAD_DRAG_MIME, threadId);

/**
 * Ìtútù arrangement: Present at the top; Needs you, Later, and Done anchored together at the
 * bottom. Groups are derived from known thread summaries and filled by bounded state pages.
 */
export function SidebarItutuSection({ shared }: { shared: SharedProjectItemProps }) {
  const summaries = useStore((store) => store.sidebarThreadsById);
  const projects = useStore((store) => store.projects);
  const collapsedStates = useItutuStore((store) => store.collapsedStates);
  const setStateCollapsed = useItutuStore((store) => store.setStateCollapsed);
  const { pages, loadMore } = useItutuCatalog(true);
  const groups = useMemo(() => groupItutuThreadIds(summaries), [summaries]);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const [dropTarget, setDropTarget] = useState<ThreadOrganizationState | null>(null);

  const renderGroup = (state: ThreadOrganizationState) => {
    const threadIds = groups[state];
    const expanded = !collapsedStates.includes(state);
    const page = pages[state];
    const acceptsDrag = (event: DragEvent) =>
      event.dataTransfer.types.includes(BIGBUD_ITUTU_THREAD_DRAG_MIME);
    return (
      <SidebarGroup
        key={state}
        data-itutu-state={state}
        className={`rounded-lg px-2 py-0 ${dropTarget === state ? "bg-accent/40" : ""}`}
        onDragOver={(event) => {
          if (!acceptsDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropTarget(state);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDropTarget(null);
        }}
        onDrop={(event) => {
          setDropTarget(null);
          const threadId = readItutuDragThreadId(
            event.dataTransfer,
            new Set(Object.keys(summaries)),
          );
          if (!threadId) return;
          event.preventDefault();
          const summary = summaries[threadId];
          if (summary && organizationStateOf(summary) !== state) {
            void moveThreadsToState([threadId], state);
          }
        }}
      >
        <SidebarItutuGroupLabel
          state={state}
          isExpanded={expanded}
          onExpandedChange={(next) => setStateCollapsed(state, !next)}
        />
        {expanded ? (
          <SidebarMenuSub className="ml-5 mr-0 my-0 translate-x-0 gap-0.5 border-l-0 px-0 py-0">
            {threadIds.map((threadId) => (
              <ItutuThreadRow
                key={threadId}
                threadId={threadId}
                orderedThreadIds={threadIds}
                summary={summaries[threadId]}
                projectById={projectById}
                shared={shared}
              />
            ))}
            {page.nextCursor !== null || page.status === "error" ? (
              <SidebarMenuSubItem className="w-full">
                <SidebarMenuSubButton
                  render={<button type="button" disabled={page.status === "loading"} />}
                  data-thread-selection-safe
                  size="sm"
                  className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                  onClick={() => loadMore(state)}
                >
                  {page.status === "loading"
                    ? "Loading…"
                    : page.status === "error"
                      ? "Couldn't load threads. Try again"
                      : "Show more"}
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ) : null}
          </SidebarMenuSub>
        ) : null}
      </SidebarGroup>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col pb-2" data-testid="itutu-section">
      {renderGroup("present")}
      <div className="mt-auto flex flex-col gap-1 pt-4">{ITUTU_BOTTOM_STATES.map(renderGroup)}</div>
    </div>
  );
}

function ItutuThreadRow(props: {
  threadId: ThreadId;
  orderedThreadIds: readonly ThreadId[];
  summary: SidebarThreadSummary | undefined;
  projectById: ReadonlyMap<string, Project>;
  shared: SharedProjectItemProps;
}) {
  const { shared, threadId, summary } = props;
  const location = summary
    ? resolveItutuLocation(summary, props.projectById.get(summary.projectId))
    : null;
  return (
    <SidebarThreadRow
      threadId={threadId}
      orderedProjectThreadIds={props.orderedThreadIds}
      routeThreadId={shared.routeThreadId}
      selectedThreadIds={shared.selectedThreadIds}
      showThreadJumpHints={shared.showThreadJumpHints}
      jumpLabel={shared.threadJumpLabelById.get(threadId) ?? null}
      renamingThreadId={shared.renamingThreadId}
      renamingTitle={shared.renamingTitle}
      setRenamingTitle={shared.setRenamingTitle}
      onRenamingInputMount={shared.onRenamingInputMount}
      hasRenameCommitted={shared.hasRenameCommitted}
      markRenameCommitted={shared.markRenameCommitted}
      handleThreadClick={shared.handleThreadClick}
      navigateToThread={shared.navigateToThread}
      handleMultiSelectContextMenu={shared.handleMultiSelectContextMenu}
      handleThreadContextMenu={shared.handleThreadContextMenu}
      clearSelection={shared.clearSelection}
      commitRename={shared.commitRename}
      cancelRename={shared.cancelRename}
      branchThread={shared.branchThread}
      requestThreadDelete={shared.requestThreadDelete}
      openPrLink={shared.openPrLink}
      pr={shared.prByThreadId.get(threadId) ?? null}
      favoriteThreadIds={shared.favoriteThreadIds}
      automationThreadIds={shared.automationThreadIds}
      toggleFavoriteThread={shared.toggleFavoriteThread}
      {...(location ? { secondaryLine: <SidebarItutuLocationLine location={location} /> } : {})}
      addDragData={addItutuDragData(threadId)}
    />
  );
}

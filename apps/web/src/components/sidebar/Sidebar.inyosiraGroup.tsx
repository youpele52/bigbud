import type { ThreadId } from "@bigbud/contracts";
import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { useState, type DragEvent } from "react";

import { getRemainingSidebarThreadCount } from "../../logic/thread/sidebarThreadCount.logic";
import type { Project, SidebarThreadSummary } from "../../models/types/app.types";
import { useInyosiraStore, type InyosiraStatePage } from "../../stores/inyosira/inyosira.store";
import { SidebarGroup, SidebarMenuSub } from "../ui/sidebar";
import { moveThreadsToState } from "./Sidebar.inyosira.actions";
import { useInyosiraThreadCount } from "./Sidebar.inyosira.count";
import {
  BIGBUD_INYOSIRA_THREAD_DRAG_MIME,
  organizationStateOf,
  previewInyosiraThreadIds,
  readInyosiraDragThreadId,
  resolveInyosiraLocation,
} from "./Sidebar.inyosira.logic";
import { SidebarInyosiraGroupLabel } from "./Sidebar.inyosiraGroupLabel";
import { SidebarInyosiraLocationLine } from "./Sidebar.inyosiraLocation";
import type { SharedProjectItemProps } from "./Sidebar.types";
import { SidebarThreadListControls } from "./SidebarThreadListControls";
import { SidebarThreadRow } from "./SidebarThreadRow";

interface SidebarInyosiraGroupProps {
  state: ThreadOrganizationState;
  threadIds: readonly ThreadId[];
  summaries: Readonly<Record<string, SidebarThreadSummary>>;
  projectById: ReadonlyMap<string, Project>;
  page: InyosiraStatePage;
  loadMore: (state: ThreadOrganizationState) => void;
  shared: SharedProjectItemProps;
}

/** One independently collapsible group with bounded row mounting and shared project controls. */
export function SidebarInyosiraGroup({
  state,
  threadIds,
  summaries,
  projectById,
  page,
  loadMore,
  shared,
}: SidebarInyosiraGroupProps) {
  const expanded = useInyosiraStore((store) => !store.collapsedStates.includes(state));
  const showAll = useInyosiraStore((store) => store.expandedThreadLists.includes(state));
  const setStateCollapsed = useInyosiraStore((store) => store.setStateCollapsed);
  const setThreadListExpanded = useInyosiraStore((store) => store.setThreadListExpanded);
  const count = useInyosiraThreadCount(state);
  const [dropTarget, setDropTarget] = useState(false);
  const preview = previewInyosiraThreadIds(threadIds, false, shared.routeThreadId);
  const visibleIds = showAll ? threadIds : preview.visibleItems;
  // Membership can update before the debounced total; do not label controls with stale counts.
  const totalCount =
    count.status === "loaded" && count.count >= threadIds.length ? count.count : undefined;
  const collapsedHiddenCount = getRemainingSidebarThreadCount({
    authoritativeActiveThreadCount: totalCount,
    representedThreadIds: preview.visibleItems,
  });
  const unloadedCount = getRemainingSidebarThreadCount({
    authoritativeActiveThreadCount: totalCount,
    representedThreadIds: threadIds,
  });
  const hasHiddenThreads =
    preview.hiddenCount > 0 ||
    (collapsedHiddenCount === null ? page.nextCursor !== null : collapsedHiddenCount > 0);
  const hasMoreThreads = page.nextCursor !== null && (unloadedCount === null || unloadedCount > 0);
  const acceptsDrag = (event: DragEvent) =>
    event.dataTransfer.types.includes(BIGBUD_INYOSIRA_THREAD_DRAG_MIME);

  return (
    <SidebarGroup
      data-inyosira-state={state}
      className={`rounded-lg px-2 py-0 ${dropTarget ? "bg-accent/40" : ""}`}
      onDragOver={(event) => {
        if (!acceptsDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTarget(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(false);
      }}
      onDrop={(event) => {
        setDropTarget(false);
        const threadId = readInyosiraDragThreadId(
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
      <SidebarInyosiraGroupLabel
        state={state}
        result={count}
        isExpanded={expanded}
        onExpandedChange={(next) => setStateCollapsed(state, !next)}
      />
      {expanded ? (
        <SidebarMenuSub className="ml-5 mr-0 my-0 translate-x-0 gap-0.5 border-l-0 px-0 py-0 [&>[data-thread-item]]:px-2">
          {visibleIds.map((threadId) => (
            <InyosiraThreadRow
              key={threadId}
              threadId={threadId}
              orderedThreadIds={visibleIds}
              summary={summaries[threadId]}
              projectById={projectById}
              shared={shared}
            />
          ))}
          <SidebarThreadListControls
            hasHiddenThreads={hasHiddenThreads}
            hasMoreThreads={hasMoreThreads}
            collapsedHiddenCount={collapsedHiddenCount}
            unloadedCount={unloadedCount}
            isExpanded={showAll}
            isLoading={page.status === "loading"}
            loadError={page.status === "error"}
            onExpandedChange={(next) => setThreadListExpanded(state, next)}
            onLoadMore={() => loadMore(state)}
          />
        </SidebarMenuSub>
      ) : null}
    </SidebarGroup>
  );
}

const addInyosiraDragData = (threadId: ThreadId) => (dataTransfer: DataTransfer) =>
  dataTransfer.setData(BIGBUD_INYOSIRA_THREAD_DRAG_MIME, threadId);

function InyosiraThreadRow(props: {
  threadId: ThreadId;
  orderedThreadIds: readonly ThreadId[];
  summary: SidebarThreadSummary | undefined;
  projectById: ReadonlyMap<string, Project>;
  shared: SharedProjectItemProps;
}) {
  const { shared, threadId, summary } = props;
  const location = summary
    ? resolveInyosiraLocation(summary, props.projectById.get(summary.projectId))
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
      {...(location ? { secondaryLine: <SidebarInyosiraLocationLine location={location} /> } : {})}
      addDragData={addInyosiraDragData(threadId)}
    />
  );
}

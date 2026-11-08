import "../../index.css";

import {
  ProjectId,
  ThreadId,
  type GetProjectThreadSummariesInput,
  type NativeApi,
  type ThreadSummary,
} from "@bigbud/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render } from "vitest-browser-react";

import { SIDEBAR_THREAD_PREVIEW_LIMIT } from "../../constants/sidebar";
import { loadMoreProjectThreadSummaries } from "../../routes/-__root.bounded-bootstrap";
import { useStore } from "../../stores/main";
import { getVisibleThreadsForProject } from "./Sidebar.logic";
import { sortThreadsForSidebar } from "./Sidebar.sort.logic";
import { SidebarRenderedProjectItemThreadList } from "./SidebarRenderedProjectItem.thread-list";

vi.mock("./SidebarThreadRow", () => ({
  SidebarThreadRow: (props: { threadId: ThreadId }) => (
    <li data-testid="paged-thread-row">{props.threadId}</li>
  ),
}));

const projectId = ProjectId.makeUnsafe("paged-project");
const TOTAL = 10;

/** Threads whose activity order differs from creation order, as the sidebar displays them. */
const allThreads: ThreadSummary[] = Array.from({ length: TOTAL }, (_, index) => ({
  id: ThreadId.makeUnsafe(`paged-${String(index).padStart(2, "0")}`),
  projectId,
  title: `Thread ${index}`,
  purpose: "standard",
  elevatorSummary: null,
  modelSelection: { provider: "codex", model: "gpt-5.5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  providerRuntimeExecutionTargetId: "local",
  workspaceExecutionTargetId: "local",
  executionTargetId: "local",
  branch: null,
  worktreePath: null,
  createdAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 2, 1)).toISOString(),
  latestUserMessageAt: new Date(Date.UTC(2026, 1, 1 + ((index * 7) % TOTAL))).toISOString(),
  pinnedAt: null,
  sessionStatus: null,
  providerName: null,
  activeTurnId: null,
  latestTurnState: null,
  isWatching: false,
  isWatched: false,
  isDelegated: false,
  isAwaitingApproval: false,
}));
const displayOrder = sortThreadsForSidebar(allThreads, "updated_at").map((thread) => thread.id);

/** Server stand-in: keyset pages of 4 in the requested display order. */
const getProjectThreadSummaries = vi.fn(async (input: GetProjectThreadSummariesInput) => {
  const start = input.cursor ? displayOrder.indexOf(input.cursor.threadId) + 1 : 0;
  const ids = displayOrder.slice(start, start + (input.limit ?? 4));
  const last = allThreads.find((thread) => thread.id === ids.at(-1));
  return {
    projectionSequence: 1,
    projectId,
    threads: ids.map((id) => allThreads.find((thread) => thread.id === id)!),
    ...(start + ids.length < TOTAL && last
      ? { nextCursor: { updatedAt: last.updatedAt, threadId: last.id } }
      : {}),
  };
});
const api = { orchestration: { getProjectThreadSummaries } } as unknown as NativeApi;
const NO_THREAD_IDS: ThreadId[] = [];

function PagedProjectHarness() {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const threadIds = useStore((state) => state.threadIdsByProjectId[projectId] ?? NO_THREAD_IDS);
  const summaries = useStore((state) => state.sidebarThreadsById);
  const cursor = useStore((state) => state.threadSummaryCursorByProjectId?.[projectId]);
  const threads = sortThreadsForSidebar(
    threadIds.flatMap((id) => (summaries[id] ? [summaries[id]] : [])),
    "updated_at",
  );
  const preview = getVisibleThreadsForProject({
    threads,
    activeThreadId: undefined,
    isThreadListExpanded: false,
    previewLimit: SIDEBAR_THREAD_PREVIEW_LIMIT,
  });
  const visible = expanded ? threads : preview.visibleThreads;
  const unloadedCount = TOTAL - threads.length;
  return (
    <SidebarRenderedProjectItemThreadList
      projectId={projectId}
      orderedProjectThreadIds={threads.map((thread) => thread.id)}
      visibleThreadIds={visible.map((thread) => thread.id)}
      routeThreadId={null}
      selectedThreadIds={new Set<ThreadId>()}
      showThreadJumpHints={false}
      threadJumpLabelById={new Map()}
      renamingThreadId={null}
      renamingTitle=""
      setRenamingTitle={vi.fn()}
      onRenamingInputMount={vi.fn()}
      hasRenameCommitted={() => false}
      markRenameCommitted={vi.fn()}
      handleThreadClick={vi.fn()}
      navigateToThread={vi.fn()}
      handleMultiSelectContextMenu={vi.fn(async () => {})}
      handleThreadContextMenu={vi.fn(async () => {})}
      clearSelection={vi.fn()}
      commitRename={vi.fn(async () => {})}
      cancelRename={vi.fn()}
      branchThread={vi.fn(async () => {})}
      favoriteThreadIds={new Set()}
      automationThreadIds={new Set()}
      toggleFavoriteThread={vi.fn(async () => {})}
      requestThreadDelete={vi.fn(async () => {})}
      openPrLink={vi.fn()}
      prByThreadId={new Map()}
      attachThreadListAutoAnimateRef={vi.fn()}
      shouldShowThreadPanel={true}
      showEmptyThreadState={false}
      hasHiddenThreads={TOTAL - SIDEBAR_THREAD_PREVIEW_LIMIT > 0}
      hasMoreThreads={cursor !== null}
      threadCounts={{
        collapsedHiddenCount: TOTAL - SIDEBAR_THREAD_PREVIEW_LIMIT,
        unloadedCount,
        hiddenLoadedCount: preview.hiddenThreads.length,
      }}
      isThreadListExpanded={expanded}
      isLoadingMoreThreads={loading}
      expandThreadListForProject={() => setExpanded(true)}
      collapseThreadListForProject={() => setExpanded(false)}
      loadMoreThreadsForProject={() => {
        setLoading(true);
        void loadMoreProjectThreadSummaries({ api, projectId }).finally(() => setLoading(false));
      }}
      projectExpanded={true}
    />
  );
}

const renderedIds = () =>
  [...document.querySelectorAll('[data-testid="paged-thread-row"]')].map((row) => row.textContent);

beforeEach(() => {
  getProjectThreadSummaries.mockClear();
  useStore.setState({ threads: [], sidebarThreadsById: {}, threadIdsByProjectId: {} });
  useStore.setState({ threadSummaryCursorByProjectId: {}, threadHydrationById: {} });
});

describe("sidebar project paging", () => {
  it("shows 4 threads, then fetches the next 4 from the server in display order", async () => {
    await loadMoreProjectThreadSummaries({ api, projectId });
    await render(<PagedProjectHarness />);
    await expect.poll(renderedIds).toEqual(displayOrder.slice(0, 4));
    expect(getProjectThreadSummaries).toHaveBeenLastCalledWith({
      projectId,
      limit: 4,
      sortOrder: "updated_at",
    });

    await page.getByText("Show 4 more").click();
    await expect.poll(renderedIds).toEqual(displayOrder.slice(0, 8));
    expect(getProjectThreadSummaries).toHaveBeenCalledTimes(2);
    expect(getProjectThreadSummaries.mock.calls[1]![0]).toMatchObject({
      limit: 4,
      sortOrder: "updated_at",
      cursor: { threadId: displayOrder[3] },
    });

    await page.getByText("Show 2 more").click();
    await expect.poll(renderedIds).toEqual(displayOrder);
    await expect.element(page.getByText(/^Show \d+ more$/)).not.toBeInTheDocument();

    await page.getByText("Show less").click();
    await expect.poll(renderedIds).toEqual(displayOrder.slice(0, 4));
    expect(getProjectThreadSummaries).toHaveBeenCalledTimes(3);
  });
});

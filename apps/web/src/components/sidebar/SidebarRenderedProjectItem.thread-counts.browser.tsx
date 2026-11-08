import "../../index.css";

import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render } from "vitest-browser-react";

import { SidebarRenderedProjectItemThreadList } from "./SidebarRenderedProjectItem.thread-list";

const projectId = ProjectId.makeUnsafe("project-counts");

function SidebarThreadCountHarness() {
  const [expanded, setExpanded] = useState(false);
  // The first server page holds 4 threads, matching the 4-row preview.
  const [loadedCount, setLoadedCount] = useState(4);
  const loadedThreadIds = Array.from({ length: loadedCount }, (_, index) =>
    ThreadId.makeUnsafe(`loaded-thread-${index + 1}`),
  );
  return (
    <SidebarRenderedProjectItemThreadList
      projectId={projectId}
      orderedProjectThreadIds={loadedThreadIds}
      visibleThreadIds={expanded ? loadedThreadIds : loadedThreadIds.slice(0, 4)}
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
      hasHiddenThreads={true}
      hasMoreThreads={loadedCount < 94}
      threadCounts={{
        collapsedHiddenCount: 90,
        unloadedCount: 94 - loadedCount,
        hiddenLoadedCount: expanded ? 0 : loadedCount - 4,
      }}
      isThreadListExpanded={expanded}
      isLoadingMoreThreads={false}
      expandThreadListForProject={() => setExpanded(true)}
      collapseThreadListForProject={() => setExpanded(false)}
      loadMoreThreadsForProject={() => setLoadedCount((count) => count + 4)}
      projectExpanded={true}
    />
  );
}

describe("authoritative sidebar thread counts", () => {
  it("shows 4 more per click, fetching the next page each time, with honest counts", async () => {
    await render(<SidebarThreadCountHarness />);

    await expect.element(page.getByText("Show 4 more")).toBeInTheDocument();
    await expect.element(page.getByText("Show less")).not.toBeInTheDocument();
    await page.getByText("Show 4 more").click();

    // Expanded with 8 loaded: the next click fetches another page of 4.
    await expect.element(page.getByText("Show less")).toBeInTheDocument();
    await page.getByText("Show 4 more").click();
    await expect.element(page.getByText("Show 4 more")).toBeInTheDocument();

    await page.getByText("Show less").click();
    // Collapsed with loaded rows hidden: reveal those first, without fetching.
    await expect.element(page.getByText("Show 8 more")).toBeInTheDocument();
  });
});

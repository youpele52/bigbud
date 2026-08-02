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
  const [loadedCount, setLoadedCount] = useState(5);
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
      threadCounts={{ collapsedHiddenCount: 90, unloadedCount: 94 - loadedCount }}
      isThreadListExpanded={expanded}
      isLoadingMoreThreads={false}
      expandThreadListForProject={() => setExpanded(true)}
      collapseThreadListForProject={() => setExpanded(false)}
      loadMoreThreadsForProject={() => setLoadedCount((count) => count + 5)}
      projectExpanded={true}
    />
  );
}

describe("authoritative sidebar thread counts", () => {
  it("renders collapsed and unloaded counts and decrements after pagination", async () => {
    await render(<SidebarThreadCountHarness />);

    await expect.element(page.getByText("See more (90)")).toBeInTheDocument();
    await page.getByText("See more (90)").click();
    await expect.element(page.getByText("Show less")).toBeInTheDocument();
    await expect.element(page.getByText("Load more (89)")).toBeInTheDocument();

    await page.getByText("Load more (89)").click();

    await expect.element(page.getByText("Load more (84)")).toBeInTheDocument();
    await expect.element(page.getByText("Show less")).toBeInTheDocument();
  });
});

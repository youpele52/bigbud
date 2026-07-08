import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts";
import { SidebarFavoritesSection } from "./Sidebar.favoritesSection";
import type { SharedProjectItemProps, SidebarRenderedThreadEntry } from "./Sidebar.types";

vi.mock("../ui/sidebar", () => ({
  SidebarGroup: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({
    children,
    className,
    onClick,
  }: {
    children: React.ReactNode;
    className?: string;
    onClick?: () => void;
  }) => (
    <div className={className} onClick={onClick}>
      {children}
    </div>
  ),
  SidebarMenuSub: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("../ui/spinner", () => ({
  Spinner: ({ className }: { className?: string }) => <div className={className}>spinner</div>,
}));

vi.mock("./SidebarThreadRow", () => ({
  SidebarThreadRow: ({ threadId }: { threadId: ThreadId }) => <div>thread:{threadId}</div>,
}));

function buildSharedProjectItemProps(): SharedProjectItemProps {
  return {
    isManualProjectSorting: false,
    newThreadShortcutLabel: null,
    showThreadJumpHints: false,
    threadJumpLabelById: new Map(),
    appSettingsDefaultThreadEnvMode: "local",
    routeThreadId: null,
    selectedThreadIds: new Set(),
    renamingThreadId: null,
    renamingTitle: "",
    setRenamingTitle: vi.fn(),
    onRenamingInputMount: vi.fn(),
    hasRenameCommitted: vi.fn(() => false),
    markRenameCommitted: vi.fn(),
    favoriteThreadIds: new Set(),
    automationThreadIds: new Set(),
    toggleFavoriteThread: vi.fn(async () => {}),
    activeThread: null,
    activeDraftThread: null,
    renamingProjectId: null,
    renamingProjectTitle: "",
    setRenamingProjectTitle: vi.fn(),
    onProjectRenamingInputMount: vi.fn(),
    hasProjectRenameCommitted: vi.fn(() => false),
    markProjectRenameCommitted: vi.fn(),
    commitProjectRename: vi.fn(async () => {}),
    cancelProjectRename: vi.fn(),
    requestProjectDelete: vi.fn(),
    attachThreadListAutoAnimateRef: vi.fn(),
    handleProjectTitlePointerDownCapture: vi.fn(),
    handleProjectTitleClick: vi.fn(),
    handleProjectTitleKeyDown: vi.fn(),
    handleProjectContextMenu: vi.fn(),
    handleThreadClick: vi.fn(),
    navigateToThread: vi.fn(),
    handleMultiSelectContextMenu: vi.fn(async () => {}),
    handleThreadContextMenu: vi.fn(async () => {}),
    clearSelection: vi.fn(),
    commitRename: vi.fn(async () => {}),
    cancelRename: vi.fn(),
    branchThread: vi.fn(async () => {}),
    requestThreadDelete: vi.fn(async () => {}),
    openPrLink: vi.fn(),
    prByThreadId: new Map(),
    handleNewThread: vi.fn(async () => {}),
    expandThreadListForProject: vi.fn(),
    collapseThreadListForProject: vi.fn(),
  };
}

function renderFavoritesSection({
  renderedFavorites = [],
  isExpanded = true,
  bootstrapComplete = true,
}: {
  renderedFavorites?: SidebarRenderedThreadEntry[];
  isExpanded?: boolean;
  bootstrapComplete?: boolean;
} = {}) {
  return renderToStaticMarkup(
    <SidebarFavoritesSection
      renderedFavorites={renderedFavorites}
      isExpanded={isExpanded}
      onExpandedChange={vi.fn()}
      sharedProjectItemProps={buildSharedProjectItemProps()}
      bootstrapComplete={bootstrapComplete}
    />,
  );
}

describe("SidebarFavoritesSection", () => {
  it("renders Pinned without the redundant Favourites section label", () => {
    const html = renderFavoritesSection();

    expect(html).toContain("Pinned");
    expect(html).not.toContain("Favourites");
    expect(html).toContain("No pinned threads yet");
  });

  it("keeps the empty state hidden when Pinned is collapsed", () => {
    const html = renderFavoritesSection({ isExpanded: false });

    expect(html).toContain("Pinned");
    expect(html).not.toContain("No pinned threads yet");
  });

  it("renders pinned thread rows when favorites exist", () => {
    const orderedThreadIds = [
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ] as const;
    const html = renderFavoritesSection({
      renderedFavorites: orderedThreadIds.map((threadId) => ({
        threadId,
        orderedThreadIds,
      })),
    });

    expect(html).toContain("thread:thread-1");
    expect(html).toContain("thread:thread-2");
    expect(html).not.toContain("No pinned threads yet");
  });

  it("shows a loading spinner before bootstrap completes", () => {
    const html = renderFavoritesSection({ bootstrapComplete: false });

    expect(html).toContain("spinner");
    expect(html).not.toContain("Pinned");
    expect(html).not.toContain("No pinned threads yet");
  });
});

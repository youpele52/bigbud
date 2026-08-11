import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts";

import { SidebarChatsSection } from "./Sidebar.chatsSection";
import type { SharedProjectItemProps, SidebarRenderedThreadEntry } from "./Sidebar.types";

vi.mock("../ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuSubButton: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
  SidebarMenuSubItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("./SidebarSectionLabel", () => ({
  SidebarSectionLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("./SidebarThreadRow", () => ({
  SidebarThreadRow: ({ threadId }: { threadId: ThreadId }) => <div>thread:{threadId}</div>,
}));

function renderChatsSection(input: {
  renderedChats: SidebarRenderedThreadEntry[];
  showAll: boolean;
  hasMoreChats: boolean;
  collapsedHiddenChatCount: number | null;
  unloadedChatCount: number | null;
}) {
  return renderToStaticMarkup(
    <SidebarChatsSection
      {...input}
      isExpanded
      onExpandedChange={vi.fn()}
      onShowAllChange={vi.fn()}
      isLoadingMoreChats={false}
      onLoadMoreChats={vi.fn()}
      onNewChat={vi.fn()}
      newThreadShortcutLabel={null}
      sharedProjectItemProps={
        {
          threadJumpLabelById: new Map(),
          prByThreadId: new Map(),
        } as SharedProjectItemProps
      }
    />,
  );
}

describe("SidebarChatsSection", () => {
  const orderedThreadIds = Array.from({ length: 6 }, (_, index) =>
    ThreadId.makeUnsafe(`chat-${index + 1}`),
  );
  const renderedChats = orderedThreadIds.map((threadId) => ({
    threadId,
    orderedThreadIds,
  }));

  it("uses the project-style preview count before Recents is expanded", () => {
    const html = renderChatsSection({
      renderedChats,
      showAll: false,
      hasMoreChats: true,
      collapsedHiddenChatCount: 2,
      unloadedChatCount: 1,
    });

    expect(html).toContain("thread:chat-4");
    expect(html).not.toContain("thread:chat-5");
    expect(html).toContain("See more (2)");
    expect(html).not.toContain("Load more");
  });

  it("keeps Show less and Load more as separate expanded controls", () => {
    const html = renderChatsSection({
      renderedChats,
      showAll: true,
      hasMoreChats: true,
      collapsedHiddenChatCount: 2,
      unloadedChatCount: 1,
    });

    expect(html).toContain("thread:chat-6");
    expect(html).toContain("Show less");
    expect(html).toContain("Load more (1)");
  });
});

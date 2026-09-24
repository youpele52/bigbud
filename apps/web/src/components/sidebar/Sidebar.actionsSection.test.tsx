import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const gitStatus = vi.hoisted(() => ({ value: "available" as "available" | "missing" }));
const sidebarPreferences = vi.hoisted(() => ({ hidden: [] as string[] }));

vi.mock("../../stores/ui/search.store", () => ({
  useSearchStore: (selector: (state: { toggleSearchOpen: () => void }) => unknown) =>
    selector({ toggleSearchOpen: vi.fn() }),
}));

vi.mock("../../rpc/serverState", () => ({
  useServerKeybindings: () => [],
}));

vi.mock("./Sidebar.actions.git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./Sidebar.actions.git")>()),
  usePluginGitAvailability: () => ({ status: gitStatus.value, check: vi.fn() }),
}));

vi.mock("../../stores/ui/ui.store", () => ({
  useUiStateStore: (selector: (state: unknown) => unknown) =>
    selector({
      sidebarActionOrder: [
        "plugins",
        "scheduled",
        "games",
        "usage",
        "pinned",
        "chats",
        "projects",
        "remote-projects",
      ],
      hiddenSidebarActions: sidebarPreferences.hidden,
      setSidebarActionHidden: vi.fn(),
      setAllSidebarActionsHidden: vi.fn(),
      reorderSidebarAction: vi.fn(),
      moveSidebarActionToEdge: vi.fn(),
      resetSidebarActionOrder: vi.fn(),
    }),
}));

// Tooltip uses portals and Base UI primitives that don't render cleanly with
// renderToStaticMarkup. Stub the trigger to render its `render` element + children
// inline so the static markup reflects the actual structure.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
    render,
  }: {
    children: React.ReactNode;
    render?: React.ReactElement;
  }) => (
    <>
      {render}
      {children}
    </>
  ),
}));

import { SidebarActionsSection } from "./Sidebar.actionsSection";

function renderActions(newThreadShortcutLabel: string | null = null) {
  return renderToStaticMarkup(
    <SidebarActionsSection
      onNewChat={vi.fn()}
      newThreadShortcutLabel={newThreadShortcutLabel}
      onOpenAutomations={vi.fn()}
      onOpenUsage={vi.fn()}
      onOpenGames={vi.fn()}
      sections={{
        pinned: () => <div>Pinned section</div>,
        chats: () => <div>Chats section</div>,
        projects: () => <div>Projects section</div>,
        "remote-projects": () => <div>Remote Projects section</div>,
      }}
    />,
  );
}

describe("SidebarActionsSection", () => {
  it("renders the two visual groups in order", () => {
    const html = renderActions();
    expect(html).toContain('data-sidebar-visual-group="primary"');
    expect(html).toContain('data-sidebar-visual-group="secondary"');
    expect(html.indexOf("Usage")).toBeLessThan(
      html.indexOf('data-sidebar-visual-group="secondary"'),
    );
    expect(html.indexOf("Pinned section")).toBeGreaterThan(
      html.indexOf('data-sidebar-visual-group="secondary"'),
    );
  });
  it("hides every configurable section while New chat and Search remain fixed", () => {
    sidebarPreferences.hidden = [
      "plugins",
      "scheduled",
      "games",
      "usage",
      "pinned",
      "chats",
      "projects",
      "remote-projects",
    ];
    try {
      const html = renderActions();
      expect(html).toContain('aria-label="New chat"');
      expect(html).toContain('aria-label="Open search"');
      expect(html).not.toContain("Hidden items");
      expect(html).not.toContain("Pinned section");
      expect(html).not.toContain("Remote Projects section");
      expect(html).not.toContain('aria-label="Open usage"');
    } finally {
      sidebarPreferences.hidden = [];
    }
  });
  it("keeps fixed actions visible without a hidden-items row when Git is missing", () => {
    gitStatus.value = "missing";
    try {
      const html = renderActions();
      expect(html).toContain('aria-label="New chat"');
      expect(html).toContain('aria-label="Open search"');
      expect(html).not.toContain('aria-label="Open plugins"');
      expect(html).not.toContain("Hidden items");
    } finally {
      gitStatus.value = "available";
    }
  });
  it("renders the New chat, Search, Scheduled, and Usage actions with icons", () => {
    const html = renderActions();

    expect(html).toContain('aria-label="New chat"');
    expect(html).toContain('aria-label="Open search"');
    expect(html).toContain('aria-label="Open games"');
    expect(html).toContain('aria-label="Open scheduled"');
    expect(html).toContain('aria-label="Open usage"');
    expect(html).toContain("New chat");
    expect(html).toContain("Search");
    expect(html).toContain("Scheduled");
    expect(html).toContain("Usage");
    expect(html.indexOf('aria-label="Open scheduled"')).toBeLessThan(
      html.indexOf('aria-label="Open games"'),
    );
    expect(html.indexOf('aria-label="Open games"')).toBeLessThan(
      html.indexOf('aria-label="Open usage"'),
    );
  });

  it("applies the group class so per-row hover reveal works for the kbd hint", () => {
    const html = renderActions("⌘N");

    // The kbd hint is rendered with `opacity-0` by default and revealed via
    // `group-hover:opacity-100`. The button must carry the `group` class.
    expect(html).toMatch(/class="group [^"]*"/);
    expect(html).toContain("opacity-0");
    expect(html).toContain("group-hover:opacity-100");
  });

  it("renders the kbd hint for New chat when a shortcut label is provided", () => {
    const html = renderActions("⌘N");

    expect(html).toContain("⌘N");
    expect(html).toContain('data-slot="kbd"');
  });

  it("omits the kbd hint for New chat when no shortcut label is provided", () => {
    const html = renderActions(null);

    expect(html).not.toContain('data-slot="kbd"');
  });

  it("uses the same gap within both visual groups", () => {
    const html = renderActions();

    expect(html).toContain('data-sidebar-visual-group="primary" class="flex flex-col gap-0.5"');
    expect(html).toContain(
      'data-sidebar-visual-group="secondary" class="mt-4 flex flex-col gap-0.5"',
    );
  });

  it("uses a consistent height for fixed and configurable action rows", () => {
    const html = renderActions();

    expect(html).toContain('class="group flex h-7 w-full items-center');
    expect(html.match(/class="group flex h-7 w-full items-center/g)).toHaveLength(6);
  });
});

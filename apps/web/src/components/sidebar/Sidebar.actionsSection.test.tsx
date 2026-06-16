import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../stores/ui/search.store", () => ({
  useSearchStore: (selector: (state: { toggleSearchOpen: () => void }) => unknown) =>
    selector({ toggleSearchOpen: vi.fn() }),
}));

vi.mock("../../rpc/serverState", () => ({
  useServerKeybindings: () => [],
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
    <SidebarActionsSection onNewChat={vi.fn()} newThreadShortcutLabel={newThreadShortcutLabel} />,
  );
}

describe("SidebarActionsSection", () => {
  it("renders the New chat, Search, and Automations actions with icons", () => {
    const html = renderActions();

    expect(html).toContain('aria-label="New chat"');
    expect(html).toContain('aria-label="Open search"');
    expect(html).toContain('aria-label="Open automations"');
    expect(html).toContain("New chat");
    expect(html).toContain("Search");
    expect(html).toContain("Automations");
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

  it("stacks the three actions in a tight column with reduced vertical spacing", () => {
    const html = renderActions();

    // The container uses `gap-0.5` and `py-2 px-2` for tight stacking.
    expect(html).toContain("flex flex-col gap-0.5");
    expect(html).toContain("px-2 py-2");
  });

  it("uses py-1 per row for the compact spacing", () => {
    const html = renderActions();

    expect(html).toContain("py-1");
  });
});

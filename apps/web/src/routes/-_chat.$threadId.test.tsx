import { ThreadId } from "@bigbud/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockNavigate = vi.fn();
const routeState = vi.hoisted(() => ({ purpose: "standard" as "standard" | "side-chat" }));
const threadId = ThreadId.makeUnsafe("thread-1");

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (config: { component: () => React.ReactNode; search?: unknown; validateSearch?: unknown }) => ({
      ...config,
      useParams: ({ select }: { select: (params: { threadId: string }) => unknown }) =>
        select({ threadId: "thread-1" }),
      useSearch: () => ({ diff: "1" }),
    }),
  retainSearchParams: () => undefined,
  useNavigate: () => mockNavigate,
}));

vi.mock("../components/chat/view/ChatView", () => ({
  default: () => <div data-testid="chat-view">chat</div>,
}));

vi.mock("~/components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-inset">{children}</div>
  ),
}));

vi.mock("../hooks/usePageTitle", () => ({
  usePageTitle: () => undefined,
}));

vi.mock("../stores/main", () => ({
  useStore: (
    selector: (state: {
      bootstrapComplete: boolean;
      threads: Array<{ id: ThreadId; title: string; purpose: "standard" | "side-chat" }>;
    }) => unknown,
  ) =>
    selector({
      bootstrapComplete: true,
      threads: [{ id: threadId, purpose: routeState.purpose, title: "Thread" }],
    }),
}));

vi.mock("../stores/composer", () => ({
  useComposerDraftStore: (
    selector: (state: { draftThreadsByThreadId: Record<string, unknown> }) => unknown,
  ) => selector({ draftThreadsByThreadId: {} }),
}));

vi.mock("../stores/rightPanel/rightPanel.coordinator", () => ({
  registerDiffPanelCloseAction: () => () => undefined,
}));

vi.mock("../stores/rightPanel/rightPanelTabs.store", () => ({
  useRightPanelTabsStore: {
    getState: () => ({
      closeTab: () => undefined,
      ensureTabOpen: () => undefined,
    }),
  },
}));

import { ChatThreadRouteView } from "./_chat.$threadId";

describe("/_chat/$threadId route", () => {
  beforeEach(() => {
    routeState.purpose = "standard";
  });

  it("keeps rendering chat content only when diff route search is open", () => {
    const markup = renderToStaticMarkup(<ChatThreadRouteView />);

    expect(markup).toContain('data-testid="sidebar-inset"');
    expect(markup).toContain('data-testid="chat-view"');
    expect(markup).not.toContain("Loading checkpoint diff...");
  });

  it("does not render Sidecar as a full-page thread", () => {
    routeState.purpose = "side-chat";

    const markup = renderToStaticMarkup(<ChatThreadRouteView />);

    expect(markup).not.toContain('data-testid="chat-view"');
  });
});

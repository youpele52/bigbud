import { ThreadId } from "@bigbud/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockNavigate = vi.fn();
const routeState = vi.hoisted(() => ({
  purpose: "standard" as "standard" | "side-chat",
  hydrationStatus: "complete" as
    | "unloaded"
    | "loading"
    | "loadingOlder"
    | "loaded"
    | "complete"
    | "failed",
}));
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
      projects: Array<{ id: string }>;
      sidebarPinnedThreadIds: ThreadId[];
      threads: Array<{ id: ThreadId; title: string; purpose: "standard" | "side-chat" }>;
      threadHydrationById: Record<string, { status: typeof routeState.hydrationStatus }>;
    }) => unknown,
  ) =>
    selector({
      bootstrapComplete: true,
      projects: [],
      sidebarPinnedThreadIds: [],
      threads: [{ id: threadId, purpose: routeState.purpose, title: "Thread" }],
      threadHydrationById: { [threadId]: { status: routeState.hydrationStatus } },
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

import {
  ChatThreadRouteView,
  getCanonicalCollisionNavigation,
  getMissingThreadRouteAction,
  isConfirmedLocalDraftThread,
} from "./_chat.$threadId";

describe("/_chat/$threadId route", () => {
  beforeEach(() => {
    routeState.purpose = "standard";
    routeState.hydrationStatus = "complete";
  });

  it("bootstraps a missing deep-linked thread before redirecting after hydration fails", () => {
    expect(
      getMissingThreadRouteAction({
        bootstrapComplete: true,
        routeThreadExists: false,
        hydrationStatus: "unloaded",
      }),
    ).toBe("bootstrap");
    expect(
      getMissingThreadRouteAction({
        bootstrapComplete: true,
        routeThreadExists: false,
        hydrationStatus: "loading",
      }),
    ).toBeNull();
    expect(
      getMissingThreadRouteAction({
        bootstrapComplete: true,
        routeThreadExists: false,
        hydrationStatus: "failed",
      }),
    ).toBe("redirect");
  });

  it("renders a local draft only after canonical absence is confirmed", () => {
    expect(isConfirmedLocalDraftThread(true, null)).toBe(false);
    expect(
      isConfirmedLocalDraftThread(true, {
        threadId,
        status: "unavailable",
        ownership: "unconfirmed",
        reason: "offline",
      }),
    ).toBe(false);
    expect(
      isConfirmedLocalDraftThread(true, {
        threadId,
        status: "archived",
        projectId: "project-1" as never,
        serverEpoch: "server-1",
        canonicalRevision: 1,
      }),
    ).toBe(false);
    expect(
      isConfirmedLocalDraftThread(true, {
        threadId,
        status: "absent",
        serverEpoch: "server-1",
        canonicalRevision: 1,
        reusePolicy: "canonical-identity-unclaimed",
      }),
    ).toBe(true);
  });

  it("routes archived canonical ownership to the targeted archive surface", () => {
    expect(
      getCanonicalCollisionNavigation({
        threadId,
        projectId: "project-1" as never,
        status: "archived",
        serverEpoch: "server-1",
        canonicalRevision: 1,
      }),
    ).toEqual({ to: "/settings/archived", search: { threadId } });
    expect(
      getCanonicalCollisionNavigation({
        threadId,
        projectId: "project-1" as never,
        status: "deleting",
        serverEpoch: "server-1",
        canonicalRevision: 1,
      }),
    ).toEqual({ to: "/" });
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

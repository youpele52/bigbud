import "../../index.css";

import { MessageId, ThreadId, type GetSelectedThreadDetailResult } from "@bigbud/contracts";
import type { SearchConversationMessagesResult } from "@bigbud/contracts/orchestration/orchestration.search";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { searchMessages, getProjectCatalog, getSelectedThreadDetail, scrollToMessage } = vi.hoisted(
  () => ({
    searchMessages: vi.fn(),
    getProjectCatalog: vi.fn(),
    getSelectedThreadDetail: vi.fn(),
    scrollToMessage: vi.fn(),
  }),
);

vi.mock("~/rpc/nativeApi", () => ({
  ensureNativeApi: () => ({
    orchestration: {
      searchConversationMessages: searchMessages,
      getStartupProjectCatalog: getProjectCatalog,
      getSelectedThreadDetail,
    },
  }),
  readNativeApi: () => ({ orchestration: { getSelectedThreadDetail } }),
}));

import { useChatViewContentHandlers } from "../chat/view/chat-view/ChatViewContent.handlers";
import { useStore } from "../../stores/main";
import { makeThread } from "../../stores/main/main.store.test.helpers";
import { useSearchStore } from "../../stores/ui";
import { SearchPaletteDialogContent } from "./SearchPalette.content";

const THREAD_ID = ThreadId.makeUnsafe("saved-thread");
const QUERY = "needle";
const OLD_MESSAGE_ID = MessageId.makeUnsafe("saved-message-1");

const focusRuntime = { scrollBehavior: { scrollToMessage }, scheduleComposerFocus: vi.fn() };

function FocusHarness() {
  const activeThread = useStore((state) => state.threads.find((thread) => thread.id === THREAD_ID));
  const { focusMessageId } = useChatViewContentHandlers({
    base: { activeThread } as never,
    runtime: focusRuntime as never,
    thread: { activePlan: null, cardProposedPlan: null } as never,
  });
  return <div data-testid="focused-message">{focusMessageId}</div>;
}

function oldMessageDetail(): GetSelectedThreadDetailResult {
  return {
    projectionSequence: 1,
    threadId: THREAD_ID,
    projectId: makeThread().projectId,
    activityTurnId: null,
    messages: [
      {
        id: OLD_MESSAGE_ID,
        role: "user",
        text: "needle result 1",
        attachments: [],
        attachmentsTruncated: false,
        turnId: null,
        streaming: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    messageWindow: {
      order: "newest-first",
      requestedCursor: null,
      newestCursor: null,
      oldestCursor: null,
      nextCursor: null,
      hasOlder: false,
    },
    activities: [],
    activitiesTruncated: false,
    pendingApprovals: [],
    pendingApprovalsTruncated: false,
    pendingUserInputs: [],
    pendingUserInputsTruncated: false,
    activePlan: null,
    activeTasks: [],
    activeTasksTruncated: false,
    checkpoints: [],
    checkpointsTruncated: false,
  };
}

function hit(index: number) {
  return {
    messageId: MessageId.makeUnsafe(`saved-message-${index}`),
    threadId: THREAD_ID,
    projectId: makeThread().projectId,
    threadTitle: "Saved thread",
    projectName: "Project",
    snippet: `needle result ${index}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function pageResult(indexes: number[], nextCursor?: number): SearchConversationMessagesResult {
  return {
    status: "ready",
    projectionSequence: 1,
    hits: indexes.map(hit),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

async function renderPalette(input: { focusOldMessage?: boolean; query?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <SearchPaletteDialogContent activeThreadId={input.focusOldMessage ? THREAD_ID : null} />
        {input.focusOldMessage ? <FocusHarness /> : null}
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$threadId",
    component: () => <div>Opened saved thread route</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, threadRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await page.getByPlaceholder("Search").fill(input.query ?? QUERY);
  return { queryClient, router };
}

describe("saved-message palette search", () => {
  beforeEach(() => {
    searchMessages.mockReset();
    getProjectCatalog.mockReset();
    getSelectedThreadDetail.mockReset();
    scrollToMessage.mockReset();
    getProjectCatalog.mockResolvedValue({ projects: [], projectionSequence: 1, remainingCount: 0 });
    useStore.setState({
      projects: [],
      threads: [makeThread({ id: THREAD_ID, title: "needle thread", deletingAt: null })],
    });
    useSearchStore.setState({ searchOpen: true, focusRequest: null });
  });

  afterEach(() => {
    useSearchStore.setState({ searchOpen: false, focusRequest: null });
    useStore.setState({ projects: [], threads: [] });
  });

  it("hides cached messages after a successful search refetch fails while keeping thread results", async () => {
    searchMessages.mockResolvedValueOnce(pageResult([1], 42));
    const { queryClient } = await renderPalette();
    await expect.element(page.getByText("needle result 1")).toBeVisible();
    await expect.element(page.getByText("needle thread", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "See more" })).toBeVisible();

    searchMessages.mockRejectedValueOnce(new Error("server disconnected"));
    await queryClient.invalidateQueries({ queryKey: ["conversation-message-search", QUERY] });

    await expect
      .element(page.getByText("Saved message search is temporarily unavailable."))
      .toBeVisible();
    expect(page.getByText("needle result 1").query()).toBeNull();
    await expect.element(page.getByText("needle thread", { exact: true })).toBeVisible();
    expect(page.getByText("See more").query()).toBeNull();
  });

  it("fetches a second server page from See more", async () => {
    searchMessages
      .mockResolvedValueOnce(pageResult([1, 2, 3, 4, 5], 42))
      .mockResolvedValueOnce(pageResult([6]));
    await renderPalette();
    await expect.element(page.getByText("needle result 5")).toBeVisible();
    expect(page.getByText("needle result 6").query()).toBeNull();

    await page.getByRole("button", { name: "See more" }).click();
    await expect.element(page.getByText("needle result 6")).toBeVisible();
    expect(searchMessages).toHaveBeenLastCalledWith({ query: QUERY, limit: 30, cursor: 42 });
  });

  it("keeps thread search while explaining the saved-message length limit", async () => {
    const longQuery = "a".repeat(161);
    useStore.setState({
      threads: [makeThread({ id: THREAD_ID, title: longQuery, deletingAt: null })],
    });
    await renderPalette({ query: longQuery });

    await expect.element(page.getByText(longQuery, { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Shorten your query to 160 characters to search saved messages."))
      .toBeVisible();
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("requires three Unicode code points for saved-message search", async () => {
    await renderPalette({ query: "😀a" });
    await expect
      .element(page.getByText("Enter at least 3 characters to search saved messages."))
      .toBeVisible();
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("preserves the typed case when checking a Unicode query at the limit", async () => {
    const query = "İ".repeat(160);
    searchMessages.mockResolvedValueOnce(pageResult([]));
    await renderPalette({ query });

    await vi.waitFor(() => expect(searchMessages).toHaveBeenCalledWith({ query, limit: 30 }));
    expect(
      page.getByText("Shorten your query to 160 characters to search saved messages.").query(),
    ).toBeNull();
  });

  it("loads an old selected hit by anchor before focusing it", async () => {
    searchMessages.mockResolvedValueOnce(pageResult([1]));
    getSelectedThreadDetail.mockResolvedValueOnce(oldMessageDetail());
    await renderPalette({ focusOldMessage: true });
    await page.getByText("needle result 1").click();

    await expect.element(page.getByTestId("focused-message")).toHaveTextContent(OLD_MESSAGE_ID);
    expect(getSelectedThreadDetail).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      messageAnchorId: OLD_MESSAGE_ID,
      messageLimit: 20,
    });
    expect(useStore.getState().threads[0]?.messages[0]?.id).toBe(OLD_MESSAGE_ID);
    expect(useSearchStore.getState().focusRequest).toBeNull();
    expect(scrollToMessage).toHaveBeenCalledWith(OLD_MESSAGE_ID, {
      align: "center",
      behavior: "smooth",
    });
  });

  it("navigates to a saved-message thread absent from client state", async () => {
    useStore.setState({ threads: [] });
    searchMessages.mockResolvedValueOnce(pageResult([1]));
    const { router } = await renderPalette();
    await page.getByText("needle result 1").click();

    await expect.element(page.getByText("Opened saved thread route")).toBeVisible();
    expect(router.state.location.pathname).toBe(`/${THREAD_ID}`);
    expect(useStore.getState().threads).toEqual([]);
    expect(useSearchStore.getState().focusRequest).toMatchObject({
      threadId: THREAD_ID,
      messageId: OLD_MESSAGE_ID,
    });
  });
});

import "../../index.css";

import {
  BUILT_IN_CHATS_PROJECT_ID,
  ProjectId,
  ThreadId,
  type GetStartupProjectCatalogResult,
  type NativeApi,
} from "@bigbud/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { createBaseServerConfig } from "~/components/chat/view/ChatView.browser/fixtures";
import { COMPACT_CHAT_MODEL_PREFERENCE_STORAGE_KEY } from "~/models/compactChatModelPreference";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { __resetNativeApiForTests } from "~/rpc/nativeApi";
import { resetServerStateForTests, setServerConfigSnapshot } from "~/rpc/serverState";
import { useComposerDraftStore } from "~/stores/composer";
import { useStore } from "~/stores/main";
import { useCompactChatThread } from "~/hooks/useCompactChatThread";
import { mapSidebarThreadSummary } from "~/stores/main/mappers.lazy.store";

import { CompactChatPicker } from "./CompactChatPicker";
import { CompactChatShell } from "./FloatingAssistantShell";
import { threadDetail, threadSummary } from "./CompactChatSynchronization.browser/fixtures";

const NOW = "2026-08-16T12:00:00.000Z";
const MAIN_PROJECT_ID = ProjectId.makeUnsafe("main-project");

const chatsProjectPage = {
  projectionSequence: 12,
  projects: [
    {
      id: BUILT_IN_CHATS_PROJECT_ID,
      title: "Chats",
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
      workspaceRoot: null,
      lastUsedAt: NOW,
      updatedAt: NOW,
      deletingAt: null,
      threadCount: 0,
      exceptionalThreadCount: 0,
      hasExceptionalThreads: false,
    },
  ],
  remainingCount: 0,
} satisfies GetStartupProjectCatalogResult;

function createCompactRouter(queryClient: QueryClient) {
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: CompactChatTestHarness,
  });
  return createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient },
  });
}

function CompactChatTestHarness() {
  const compactChat = useCompactChatThread();
  return <CompactChatShell compactChat={compactChat} />;
}

describe("CompactChatShell", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    __resetNativeApiForTests();
    resetServerStateForTests();
    useStore.setState({
      ...useStore.getInitialState(),
      bootstrapComplete: true,
      projects: [
        {
          id: MAIN_PROJECT_ID,
          name: "Main project",
          activeThreadCount: 1,
          providerRuntimeExecutionTargetId: "local",
          workspaceExecutionTargetId: "local",
          executionTargetId: "local",
          cwd: "/repo/main",
          defaultModelSelection: null,
          updatedAt: NOW,
          deletingAt: null,
          scripts: [],
        },
      ],
      threads: [],
    });
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    localStorage.setItem(
      COMPACT_CHAT_MODEL_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ provider: "codex", model: "gpt-5.6-terra", lastUsedAt: NOW }),
    );

    const serverConfig = createBaseServerConfig();
    setServerConfigSnapshot({
      ...serverConfig,
      providers: [
        {
          ...serverConfig.providers[0]!,
          status: "ready",
          initialProbeComplete: true,
          models: [
            {
              slug: "gpt-5.6-terra",
              name: "GPT-5.6 Terra",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "nativeApi");
    Reflect.deleteProperty(window, "desktopBridge");
    document.body.innerHTML = "";
  });

  it("loads Chats, receives a screenshot and sends through an already-running provider", async () => {
    let materializedThreadId: ThreadId | null = null;
    const dispatchCommand = vi.fn(async (command: { threadId: ThreadId }) => {
      materializedThreadId = command.threadId;
      return { sequence: 13 };
    });
    const refreshProviders = vi.fn();
    const dataUrl = document.createElement("canvas").toDataURL("image/jpeg");
    let screenshotPending = true;
    const acknowledge = vi.fn(async () => {
      screenshotPending = false;
      return true;
    });
    window.desktopBridge = {
      compactChatScreenshot: {
        getPending: vi.fn(async (threadId: string) =>
          screenshotPending
            ? {
                id: "cold-start-screenshot",
                threadId,
                name: "Screenshot.jpg",
                mimeType: "image/jpeg",
                sizeBytes: atob(dataUrl.split(",")[1]!).length,
                dataUrl,
              }
            : null,
        ),
        acknowledge,
        onAvailable: () => () => undefined,
      },
      confirm: vi.fn(async () => false),
    } as unknown as NonNullable<typeof window.desktopBridge>;
    const getStartupProjectCatalog = vi.fn(async ({ scope, priorityProjectId }) =>
      scope === "local" && priorityProjectId === BUILT_IN_CHATS_PROJECT_ID
        ? chatsProjectPage
        : { projectionSequence: 12, projects: [], remainingCount: 0 },
    );
    window.nativeApi = {
      orchestration: {
        dispatchCommand,
        resolveThreadOwnership: vi.fn(async ({ threadId }: { threadId: ThreadId }) => ({
          threadId,
          status: "absent",
          serverEpoch: "server-1",
          canonicalRevision: 12,
        })),
        getStartupProjectCatalog,
        getSelectedThreadDetail: vi.fn(async ({ threadId }) => threadDetail(threadId, 13)),
        getSidebarThreadCatalog: vi.fn(async () => ({
          projectionSequence: 13,
          threads: materializedThreadId ? [threadSummary(materializedThreadId, 13)] : [],
          recentThreadIds: materializedThreadId ? [materializedThreadId] : [],
          pinnedThreadIds: [],
        })),
        getProjectThreadSummaries: vi.fn(async ({ projectId }) => ({
          projectionSequence: 13,
          projectId,
          threads: materializedThreadId ? [threadSummary(materializedThreadId, 13)] : [],
        })),
      },
      server: { refreshProviders },
    } as unknown as NativeApi;

    const queryClient = new QueryClient();
    const router = createCompactRouter(queryClient);
    const mounted = await render(
      <QueryClientProvider client={queryClient}>
        <AppAtomRegistryProvider>
          <RouterProvider router={router as never} />
        </AppAtomRegistryProvider>
      </QueryClientProvider>,
    );

    try {
      await vi.waitFor(() => {
        expect(
          useStore.getState().projects.some((project) => project.id === BUILT_IN_CHATS_PROJECT_ID),
        ).toBe(true);
      });
      expect(refreshProviders).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(acknowledge).toHaveBeenCalledExactlyOnceWith("cold-start-screenshot"),
      );
      expect(dispatchCommand).not.toHaveBeenCalled();
      // An image-only draft must survive a cancelled New chat action.
      await page.getByRole("button", { name: "New chat", exact: true }).click();
      expect(window.desktopBridge.confirm).toHaveBeenCalledWith(
        "Discard the unsent compact chat draft?",
      );
      expect(
        Object.values(useComposerDraftStore.getState().draftsByThreadId).some((draft) =>
          draft.images.some((image) => image.id === "cold-start-screenshot"),
        ),
      ).toBe(true);
      await page.getByTestId("composer-editor").fill("Hello from compact chat");
      const send = page.getByRole("button", { name: "Send message" });
      await expect.element(send).toBeEnabled();
      await send.click();

      await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(document.body.textContent).not.toContain("Floating chat could not synchronize"),
      );
      expect(dispatchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.turn.start",
          message: expect.objectContaining({
            text: "Hello from compact chat",
            attachments: expect.arrayContaining([
              expect.objectContaining({
                type: "image",
                name: "Screenshot.jpg",
                mimeType: "image/jpeg",
              }),
            ]),
          }),
          modelSelection: { provider: "codex", model: "gpt-5.6-terra" },
          bootstrap: expect.objectContaining({
            createThread: expect.objectContaining({ projectId: BUILT_IN_CHATS_PROJECT_ID }),
          }),
        }),
      );
      expect(getStartupProjectCatalog).toHaveBeenCalledWith({
        scope: "local",
        limit: 1,
        priorityProjectId: BUILT_IN_CHATS_PROJECT_ID,
      });
      expect(refreshProviders).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
      queryClient.clear();
    }
  });

  it("shows only the application loader while compact chat is preparing", async () => {
    useStore.setState({ bootstrapComplete: false });
    const queryClient = new QueryClient();
    const router = createCompactRouter(queryClient);
    const mounted = await render(
      <QueryClientProvider client={queryClient}>
        <AppAtomRegistryProvider>
          <RouterProvider router={router as never} />
        </AppAtomRegistryProvider>
      </QueryClientProvider>,
    );

    try {
      await expect.element(page.getByText("Loading application")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "New chat" })).not.toBeInTheDocument();
      await expect.element(page.getByTestId("composer-editor")).not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
      queryClient.clear();
    }
  });

  it("selects completed threads from recents without a completed section", async () => {
    const completedThreadId = ThreadId.makeUnsafe("completed-thread");
    const completedSummary = mapSidebarThreadSummary({
      ...threadSummary(completedThreadId, 13),
      title: "Completed task",
      sessionStatus: "stopped",
      latestTurnState: "completed",
    });
    const selectThread = vi.fn(async () => true);
    useStore.setState((state) => ({
      ...state,
      sidebarThreadsById: { [completedThreadId]: completedSummary },
      sidebarRecentThreadIds: [completedThreadId],
      threadIdsByProjectId: { [BUILT_IN_CHATS_PROJECT_ID]: [completedThreadId] },
    }));
    const compactChat = {
      loadMoreProjects: vi.fn(),
      loadProjectThreads: vi.fn(),
      newChat: vi.fn(async () => true),
      selectThread,
      threadTitle: "New chat",
    } as unknown as ReturnType<typeof useCompactChatThread>;
    const queryClient = new QueryClient();
    const mounted = await render(
      <QueryClientProvider client={queryClient}>
        <AppAtomRegistryProvider>
          <CompactChatPicker compactChat={compactChat} />
        </AppAtomRegistryProvider>
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("button", { name: "Choose floating chat" }).click();
      await expect.element(page.getByText("Completed", { exact: true })).not.toBeInTheDocument();
      await page.getByText("Completed task").click();
      expect(selectThread).toHaveBeenCalledWith(completedThreadId, BUILT_IN_CHATS_PROJECT_ID);
    } finally {
      await mounted.unmount();
      queryClient.clear();
    }
  });
});

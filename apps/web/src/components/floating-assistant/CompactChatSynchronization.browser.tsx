import "../../index.css";

import {
  BUILT_IN_CHATS_PROJECT_ID,
  EventId,
  MessageId,
  ThreadId,
  type GetSidebarThreadCatalogResult,
  type NativeApi,
  type OrchestrationEvent,
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
import { useCompactChatThread } from "~/hooks/useCompactChatThread";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { __resetNativeApiForTests } from "~/rpc/nativeApi";
import { emitWelcome, resetServerStateForTests, setServerConfigSnapshot } from "~/rpc/serverState";
import { useComposerDraftStore } from "~/stores/composer";
import { useStore } from "~/stores/main";
import { makeEvent } from "~/stores/main/main.store.test.helpers";
import { EventRouter } from "~/routes/-__root.logic";

import { CompactChatShell } from "./FloatingAssistantShell";
import {
  NOW,
  TURN_1,
  TURN_2,
  chatsProjectPage,
  initialReplayEvents,
  threadDetail,
  threadSummary,
} from "./CompactChatSynchronization.browser/fixtures";

function CompactSynchronizationHarness() {
  const compactChat = useCompactChatThread();
  return (
    <>
      <EventRouter ownedThreadId={compactChat.threadId} />
      <CompactChatShell compactChat={compactChat} />
    </>
  );
}

function createCompactRouter(queryClient: QueryClient) {
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: CompactSynchronizationHarness,
  });
  return createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient },
  });
}

describe("compact chat synchronization", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    __resetNativeApiForTests();
    resetServerStateForTests();
    useStore.setState({ ...useStore.getInitialState(), bootstrapComplete: false });
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    const config = createBaseServerConfig();
    setServerConfigSnapshot({
      ...config,
      providers: [{ ...config.providers[0]!, initialProbeComplete: true, status: "ready" }],
    });
    emitWelcome({
      cwd: "/repo/main",
      projectName: "Main",
      bootstrapThreadId: "main-thread" as never,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
  });

  it("promotes and continuously synchronizes the owned thread without leaking subscriptions", async () => {
    let materialized = false;
    let projectionSequence = 10;
    let ownedThreadId: ThreadId | null = null;
    const listeners = new Set<(event: OrchestrationEvent) => void>();
    let resubscribe: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const getSelectedThreadDetail = vi.fn(async ({ threadId }: { threadId: ThreadId }) => {
      ownedThreadId ??= threadId;
      if (!materialized) throw new Error("Thread not found");
      return threadDetail(threadId, projectionSequence);
    });
    const getSidebarThreadCatalog = vi.fn(
      async (): Promise<GetSidebarThreadCatalogResult> => ({
        projectionSequence,
        threads:
          materialized && ownedThreadId ? [threadSummary(ownedThreadId, projectionSequence)] : [],
        recentThreadIds: materialized && ownedThreadId ? [ownedThreadId] : [],
        pinnedThreadIds: [],
        projectThreadCounts: [
          { projectId: BUILT_IN_CHATS_PROJECT_ID, threadCount: materialized ? 1 : 0 },
        ],
      }),
    );
    let initialReplayPending = true;
    const replayEvents = vi.fn(async (fromSequenceExclusive: number) => {
      const events =
        initialReplayPending && ownedThreadId ? initialReplayEvents(ownedThreadId) : [];
      initialReplayPending = false;
      return {
        requestedFromSequenceExclusive: fromSequenceExclusive,
        retainedFromSequenceExclusive: 0,
        earliestAvailableSequence: 1,
        latestSequence: projectionSequence,
        availability: "available" as const,
        complete: true,
        events,
      };
    });
    const dispatchCommand = vi.fn(async () => {
      materialized = true;
      projectionSequence = 11;
      return { sequence: projectionSequence };
    });
    window.nativeApi = {
      orchestration: {
        dispatchCommand,
        getSelectedThreadDetail,
        getSidebarThreadCatalog,
        getStartupProjectCatalog: vi.fn(async () => chatsProjectPage(projectionSequence)),
        getProjectThreadSummaries: vi.fn(async ({ projectId }) => ({
          projectionSequence,
          projectId,
          threads: ownedThreadId ? [threadSummary(ownedThreadId, projectionSequence)] : [],
        })),
        replayEvents,
        onDomainEvent: vi.fn((listener, options) => {
          listeners.add(listener);
          resubscribe = options?.onResubscribe;
          return () => {
            listeners.delete(listener);
            unsubscribe();
          };
        }),
        onThinkingDelta: vi.fn(() => () => undefined),
      },
      terminal: { onEvent: vi.fn(() => () => undefined) },
    } as unknown as NativeApi;

    const mount = async () => {
      const queryClient = new QueryClient();
      const mounted = await render(
        <QueryClientProvider client={queryClient}>
          <AppAtomRegistryProvider>
            <RouterProvider router={createCompactRouter(queryClient) as never} />
          </AppAtomRegistryProvider>
        </QueryClientProvider>,
      );
      return { mounted, queryClient };
    };
    const first = await mount();
    try {
      await page.getByTestId("composer-editor").fill("hi");
      await page.getByRole("button", { name: "Send message" }).click();
      await vi.waitFor(() => expect(materialized).toBe(true));
      await vi.waitFor(() => expect(ownedThreadId).not.toBeNull());
      await vi.waitFor(() =>
        expect(useComposerDraftStore.getState().getDraftThread(ownedThreadId!)).toBeNull(),
      );
      expect(
        getSelectedThreadDetail.mock.calls.every(([input]) => input.threadId === ownedThreadId),
      ).toBe(true);
      expect(ownedThreadId).not.toBe(ThreadId.makeUnsafe("main-thread"));
      expect(listeners.size).toBe(1);

      const emit = (event: OrchestrationEvent) => {
        projectionSequence = event.sequence;
        for (const listener of listeners) listener(event);
      };
      emit(
        makeEvent(
          "thread.meta-updated",
          { threadId: ownedThreadId!, title: "Greet User", updatedAt: NOW },
          { sequence: 13 },
        ),
      );
      await vi.waitFor(() =>
        expect(
          useStore.getState().threads.find((thread) => thread.id === ownedThreadId)?.title,
        ).toBe("Greet User"),
      );
      emit(
        makeEvent(
          "thread.activity-appended",
          {
            threadId: ownedThreadId!,
            activity: {
              id: EventId.makeUnsafe("search-1"),
              tone: "tool",
              kind: "web.search",
              summary: "Searched the web",
              payload: {},
              turnId: TURN_1,
              createdAt: NOW,
            },
          },
          { sequence: 14 },
        ),
      );
      await vi.waitFor(() =>
        expect(
          useStore.getState().threads.find((thread) => thread.id === ownedThreadId)?.activities,
        ).toHaveLength(1),
      );
      emit(
        makeEvent(
          "thread.message-sent",
          {
            threadId: ownedThreadId!,
            messageId: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "Hi! How can I help?",
            turnId: TURN_1,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
          { sequence: 15 },
        ),
      );
      await vi.waitFor(() =>
        expect(
          useStore.getState().threads.find((thread) => thread.id === ownedThreadId),
        ).toMatchObject({
          messages: [{ text: "hi" }, { text: "Hi! How can I help?" }],
          latestTurn: { turnId: TURN_1, state: "completed" },
        }),
      );
      emit(
        makeEvent(
          "thread.message-sent",
          {
            threadId: ownedThreadId!,
            messageId: MessageId.makeUnsafe("main-user-2"),
            role: "user",
            text: "whats new",
            turnId: TURN_2,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
          { sequence: 16 },
        ),
      );
      await vi.waitFor(() =>
        expect(
          useStore.getState().threads.find((thread) => thread.id === ownedThreadId)?.messages,
        ).toHaveLength(3),
      );
      emit(
        makeEvent(
          "thread.session-set",
          {
            threadId: ownedThreadId!,
            session: {
              threadId: ownedThreadId!,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: TURN_2,
              reason: null,
              lastError: null,
              updatedAt: NOW,
            },
          },
          { sequence: 17 },
        ),
      );
      await vi.waitFor(() =>
        expect(
          useStore.getState().threads.find((thread) => thread.id === ownedThreadId)?.latestTurn
            ?.state,
        ).toBe("running"),
      );
      emit(
        makeEvent(
          "thread.activity-appended",
          {
            threadId: ownedThreadId!,
            activity: {
              id: EventId.makeUnsafe("search-2"),
              tone: "tool",
              kind: "web.search",
              summary: "Searched release notes",
              payload: {},
              turnId: TURN_2,
              createdAt: NOW,
            },
          },
          { sequence: 18 },
        ),
      );
      await vi.waitFor(() =>
        expect(
          useStore.getState().threads.find((thread) => thread.id === ownedThreadId)?.activities,
        ).toHaveLength(2),
      );
      emit(
        makeEvent(
          "thread.message-sent",
          {
            threadId: ownedThreadId!,
            messageId: MessageId.makeUnsafe("assistant-2"),
            role: "assistant",
            text: "Here is what is new.",
            turnId: TURN_2,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
          { sequence: 19 },
        ),
      );

      await vi.waitFor(() => {
        const thread = useStore
          .getState()
          .threads.find((candidate) => candidate.id === ownedThreadId);
        expect(thread?.title).toBe("Greet User");
        expect(thread?.messages.map((message) => message.text)).toEqual([
          "hi",
          "Hi! How can I help?",
          "whats new",
          "Here is what is new.",
        ]);
        expect(thread?.activities.map((activity) => activity.summary)).toEqual([
          "Searched the web",
          "Searched release notes",
        ]);
        expect(thread?.latestTurn?.state).toBe("completed");
      });
      resubscribe?.();
      await vi.waitFor(() => expect(replayEvents).toHaveBeenCalled());
    } finally {
      await first.mounted.unmount();
      first.queryClient.clear();
    }
    expect(listeners.size).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();

    const second = await mount();
    try {
      await vi.waitFor(() => expect(listeners.size).toBe(1));
      expect(window.nativeApi!.orchestration.onDomainEvent).toHaveBeenCalledTimes(2);
    } finally {
      await second.mounted.unmount();
      second.queryClient.clear();
    }
    expect(listeners.size).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});

import "../../index.css";

import {
  BUILT_IN_CHATS_PROJECT_ID,
  EventId,
  MessageId,
  ThreadId,
  type GetSidebarThreadCatalogResult,
  type ClientOrchestrationCommand,
  type NativeApi,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { __resetNativeApiForTests } from "~/rpc/nativeApi";
import { resetServerStateForTests } from "~/rpc/serverState";
import { useComposerDraftStore } from "~/stores/composer";
import { useStore } from "~/stores/main";
import { makeEvent } from "~/stores/main/main.store.test.helpers";

import { createCompactRouter } from "./CompactChatSynchronization.browser/harness";
import {
  NOW,
  compactCommandOutcome,
  nativeSettlement,
  primeCompactConnection,
  announceCompactWelcome,
  TURN_1,
  TURN_2,
  chatsProjectPage,
  deliveryBatch,
  initialReplayEvents,
  threadDetail,
  threadSummary,
} from "./CompactChatSynchronization.browser/fixtures";

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
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
  });

  it("promotes and continuously synchronizes the owned thread without leaking subscriptions", async () => {
    let materialized = false;
    let projectionSequence = 10;
    let ownedThreadId: ThreadId | null = null;
    const listeners = new Set<Parameters<NativeApi["orchestration"]["onDomainEvent"]>[0]>();
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
    const acceptedCommands = new Map<string, { threadId: ThreadId; sequence: number }>();
    const dispatchCommand = vi.fn(async (command: ClientOrchestrationCommand) => {
      if (!("threadId" in command)) throw new Error("Unexpected non-thread command");
      ownedThreadId ??= command.threadId;
      materialized = true;
      projectionSequence = 11;
      acceptedCommands.set(command.commandId, {
        threadId: command.threadId,
        sequence: projectionSequence,
      });
      return { sequence: projectionSequence };
    });
    window.nativeApi = {
      orchestration: {
        dispatchCommand,
        getCommandOutcome: compactCommandOutcome(acceptedCommands),
        acknowledgeDelivery: vi.fn(async ({ appliedThroughSequence }) => ({
          accepted: true,
          fenced: false,
          acknowledgedSequence: appliedThroughSequence,
        })),
        resolveThreadOwnership: vi.fn(async ({ threadId }: { threadId: ThreadId }) => ({
          threadId,
          ...(materialized
            ? { status: "active", projectId: BUILT_IN_CHATS_PROJECT_ID }
            : { status: "absent", reusePolicy: "canonical-identity-unclaimed" }),
          serverEpoch: "server-1",
          canonicalRevision: projectionSequence,
        })),
        getSelectedThreadDetail,
        getSidebarThreadCatalog,
        getStartupProjectCatalog: vi.fn(async () => chatsProjectPage(projectionSequence)),
        getProjectThreadSummaries: vi.fn(async ({ projectId }) => ({
          projectionSequence,
          projectId,
          threads:
            materialized && ownedThreadId ? [threadSummary(ownedThreadId, projectionSequence)] : [],
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
    await primeCompactConnection();

    const mount = async () => {
      const queryClient = new QueryClient();
      const mounted = await render(
        <QueryClientProvider client={queryClient}>
          <AppAtomRegistryProvider>
            <RouterProvider router={createCompactRouter(queryClient) as never} />
          </AppAtomRegistryProvider>
        </QueryClientProvider>,
      );
      announceCompactWelcome();
      return { mounted, queryClient };
    };
    const first = await mount();
    try {
      await vi.waitFor(
        () => expect(window.nativeApi!.orchestration.getStartupProjectCatalog).toHaveBeenCalled(),
        { timeout: 5000 },
      );
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
        for (const listener of listeners) void listener(deliveryBatch(event));
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
      emit(nativeSettlement(ownedThreadId!, TURN_1, 16));
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
          { sequence: 17 },
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
              sessionEpoch: 0,
              reason: null,
              lastError: null,
              updatedAt: NOW,
            },
          },
          { sequence: 18 },
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
          { sequence: 19 },
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
          { sequence: 20 },
        ),
      );

      emit(nativeSettlement(ownedThreadId!, TURN_2, 21));
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

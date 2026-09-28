import {
  MessageId,
  ThreadId,
  TurnId,
  type GetSelectedThreadDetailResult,
  type NativeApi,
} from "@bigbud/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyReleasedThreadHydrationEvents,
  setThreadHydrationEventApplier,
  threadHydrationEventBuffer,
} from "../logic/orchestration/thread-hydration-events.logic";
import { useStore } from "../stores/main";
import { makeEvent, makeState, makeThread } from "../stores/main/main.store.test.helpers";
import { createEventRouterRecovery } from "./-__root.recovery";

vi.mock("./-__root.ownership-reconciliation", () => ({
  reconcileAppliedCanonicalOwnership: vi.fn(async () => undefined),
}));

vi.mock("../lib/orchestrationCommandRecovery", () => ({
  clearPersistedCommandsForCanonicalEvents: vi.fn(async () => undefined),
}));

const threadId = ThreadId.makeUnsafe("thread-streaming-prefix");
const messageId = MessageId.makeUnsafe("assistant-streaming-prefix");
const turnId = TurnId.makeUnsafe("turn-streaming-prefix");
const createdAt = "2026-09-28T11:58:12.423Z";

function messageEvent(sequence: number, text: string, streaming: boolean) {
  return makeEvent(
    "thread.message-sent",
    {
      threadId,
      messageId,
      role: "assistant",
      text,
      turnId,
      streaming,
      createdAt,
      updatedAt: "2026-09-28T11:58:14.481Z",
    },
    { sequence },
  );
}

function detailWithInitialChunk(initialChunk: string): GetSelectedThreadDetailResult {
  return {
    projectionSequence: 1,
    threadId,
    projectId: useStore.getState().threads[0]!.projectId,
    activityTurnId: turnId,
    messages: [
      {
        id: messageId,
        role: "assistant",
        text: initialChunk,
        attachments: [],
        attachmentsTruncated: false,
        turnId,
        streaming: true,
        createdAt,
        updatedAt: createdAt,
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

function makeRecovery() {
  return createEventRouterRecovery({
    api: { orchestration: {} } as unknown as NativeApi,
    queryClient: new QueryClient(),
    clearAllThinkingDeltas: vi.fn(),
    reconcileThinkingActivities: vi.fn(),
    applyOrchestrationEvents: (events) => useStore.getState().applyOrchestrationEvents(events),
    syncProjects: vi.fn(),
    syncThreads: vi.fn(),
    clearThreadUi: vi.fn(),
    removeFromSelection: vi.fn(),
    removeTerminalState: vi.fn(),
    removeOrphanedTerminalStates: vi.fn(),
    applyTerminalEvent: vi.fn(),
  });
}

beforeEach(() => {
  threadHydrationEventBuffer.clear();
  setThreadHydrationEventApplier(null);
  const thread = makeThread({ id: threadId });
  useStore.setState({
    ...makeState(thread),
    threadHydrationById: { [threadId]: { status: "loading" } },
  });
});

describe("assistant delivery across selected-thread hydration", () => {
  it.each([
    ["Hi", " — what would you like to work on?"],
    ["My", " last message was: Hello"],
  ])(
    "retains an isolated %s prefix when a suffix batch ends with empty completion",
    async (initial, suffix) => {
      const recovery = makeRecovery();
      await recovery.applyEventBatch([messageEvent(1, initial, true)]);

      const hydrationToken = threadHydrationEventBuffer.begin(threadId);
      await recovery.applyEventBatch([
        messageEvent(2, suffix, true),
        messageEvent(3, "", false),
        messageEvent(4, "", false),
      ]);

      const buffered = threadHydrationEventBuffer.finish(threadId, hydrationToken, 1);
      useStore.getState().syncSelectedThreadDetail(detailWithInitialChunk(initial), false);
      applyReleasedThreadHydrationEvents(buffered);

      expect(useStore.getState().threads[0]?.messages[0]).toMatchObject({
        text: `${initial}${suffix}`,
        streaming: false,
      });
      recovery.cancel();
    },
  );
});

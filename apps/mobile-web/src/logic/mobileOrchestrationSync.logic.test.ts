import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createMobileOrchestrationSyncController,
  FALLBACK_REFETCH_DELAY_MS,
} from "./mobileOrchestrationSync.logic";

const sessionId = "session-1";
const threadId = ThreadId.makeUnsafe("thread-1");
const projectId = ProjectId.makeUnsafe("project-1");
const turnId = TurnId.makeUnsafe("turn-1");
const messageId = MessageId.makeUnsafe("message-1");

function makeThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId,
    title: "Thread",
    purpose: "standard",
    elevatorSummary: "Thread",
    elevatorSummaryMessageCount: 0,
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    deletingAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    watchingThreads: [],
  };
}

function makeSnapshot(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    projects: [],
    threads: [makeThread()],
  };
}

function makeMessageSentEvent(input: {
  readonly text: string;
  readonly streaming: boolean;
  readonly replace?: boolean;
  readonly sequence: number;
}): OrchestrationEvent {
  return {
    type: "thread.message-sent",
    sequence: input.sequence,
    occurredAt: `2026-01-01T00:00:0${input.sequence}.000Z`,
    commandId: CommandId.makeUnsafe(`command-${input.sequence}`),
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      messageId,
      role: "assistant",
      text: input.text,
      turnId,
      streaming: input.streaming,
      ...(input.replace === true ? { replace: true } : {}),
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: `2026-01-01T00:00:0${input.sequence}.000Z`,
    },
  };
}

function makeQueryClient(initial?: {
  readonly snapshot?: OrchestrationReadModel;
  readonly thread?: OrchestrationThread;
  readonly threadDetails?: ReadonlyArray<OrchestrationThread>;
}) {
  const snapshotKey = JSON.stringify(["mobile-snapshot", sessionId]);
  const store = new Map<string, unknown>();
  if (initial?.snapshot) {
    store.set(snapshotKey, initial.snapshot);
  }
  if (initial?.thread) {
    store.set(JSON.stringify(["mobile-thread", sessionId, initial.thread.id]), initial.thread);
  }
  for (const thread of initial?.threadDetails ?? []) {
    store.set(JSON.stringify(["mobile-thread", sessionId, thread.id]), thread);
    store.set(JSON.stringify(["mobile-thread", sessionId, thread.id, "variant"]), thread);
  }

  const invalidatedKeys: Array<ReadonlyArray<string>> = [];

  return {
    queryClient: {
      setQueryData<T>(
        queryKey: ReadonlyArray<string>,
        updater: (current: T | undefined) => T | undefined,
      ) {
        const encodedKey = JSON.stringify(queryKey);
        const next = updater(store.get(encodedKey) as T | undefined);
        if (next === undefined) {
          return;
        }
        store.set(encodedKey, next);
      },
      removeQueries({ queryKey }: { readonly queryKey: ReadonlyArray<string> }) {
        for (const encodedKey of store.keys()) {
          const candidate = JSON.parse(encodedKey) as ReadonlyArray<string>;
          if (queryKey.every((part, index) => candidate[index] === part)) {
            store.delete(encodedKey);
          }
        }
      },
      invalidateQueries: vi.fn(
        async ({ queryKey }: { readonly queryKey: ReadonlyArray<string> }) => {
          invalidatedKeys.push(queryKey);
        },
      ),
    },
    invalidatedKeys,
    getSnapshot() {
      return store.get(snapshotKey) as OrchestrationReadModel | undefined;
    },
    getThread(id = threadId) {
      return store.get(JSON.stringify(["mobile-thread", sessionId, id])) as
        | OrchestrationThread
        | undefined;
    },
    getThreadVariant(id = threadId) {
      return store.get(JSON.stringify(["mobile-thread", sessionId, id, "variant"])) as
        | OrchestrationThread
        | undefined;
    },
  };
}

describe("mobileOrchestrationSync.logic", () => {
  it("applies streaming assistant events to both snapshot and thread caches", () => {
    const cache = makeQueryClient({
      snapshot: makeSnapshot(),
      thread: makeThread(),
    });
    const scheduler = {
      queueMicrotask: vi.fn((callback: () => void) => callback()),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    };
    const controller = createMobileOrchestrationSyncController({
      queryClient: cache.queryClient,
      sessionId,
      scheduler,
    });

    controller.queueEvent(makeMessageSentEvent({ text: "Hel", streaming: true, sequence: 1 }));
    controller.queueEvent(makeMessageSentEvent({ text: "lo", streaming: true, sequence: 2 }));
    controller.queueEvent(
      makeMessageSentEvent({ text: "Hello", streaming: false, replace: true, sequence: 3 }),
    );

    expect(cache.getSnapshot()?.threads[0]?.messages[0]?.text).toBe("Hello");
    expect(cache.getSnapshot()?.threads[0]?.messages[0]?.streaming).toBe(false);
    expect(cache.getThread()?.messages[0]?.text).toBe("Hello");
    expect(cache.getThread()?.messages[0]?.streaming).toBe(false);
    expect(cache.invalidatedKeys).toEqual([]);
  });

  it("schedules a fallback refetch when an event cannot be applied from cache", () => {
    const timeoutCallbacks: Array<() => void> = [];
    const cache = makeQueryClient();
    const scheduler = {
      queueMicrotask: vi.fn((callback: () => void) => callback()),
      setTimeout: vi.fn((callback: () => void, delayMs: number) => {
        expect(delayMs).toBe(FALLBACK_REFETCH_DELAY_MS);
        timeoutCallbacks.push(callback);
        return 1;
      }),
      clearTimeout: vi.fn(),
    };
    const controller = createMobileOrchestrationSyncController({
      queryClient: cache.queryClient,
      sessionId,
      scheduler,
    });

    controller.queueEvent(makeMessageSentEvent({ text: "Missed", streaming: false, sequence: 1 }));

    expect(cache.invalidatedKeys).toEqual([]);
    expect(timeoutCallbacks).toHaveLength(1);

    timeoutCallbacks[0]?.();

    expect(cache.invalidatedKeys).toEqual([
      ["mobile-snapshot", sessionId],
      ["mobile-thread", sessionId],
    ]);
  });

  it("removes every deleted detail cache and invalidates surviving thread details", () => {
    const childThreadId = ThreadId.makeUnsafe("thread-child");
    const survivingChildThreadId = ThreadId.makeUnsafe("thread-surviving-child");
    const root = makeThread();
    const child = {
      ...makeThread(),
      id: childThreadId,
      parentThread: { threadId, title: "Thread" },
    };
    const survivingChild = {
      ...makeThread(),
      id: survivingChildThreadId,
      parentThread: { threadId, title: "Thread" },
    };
    const cache = makeQueryClient({
      snapshot: { ...makeSnapshot(), threads: [root, child, survivingChild] },
      threadDetails: [root, child, survivingChild],
    });
    const scheduler = {
      queueMicrotask: vi.fn((callback: () => void) => callback()),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    };
    const controller = createMobileOrchestrationSyncController({
      queryClient: cache.queryClient,
      sessionId,
      scheduler,
    });

    controller.queueEvent({
      type: "thread.deleted",
      sequence: 2,
      occurredAt: "2026-01-01T00:00:02.000Z",
      commandId: CommandId.makeUnsafe("command-delete"),
      eventId: EventId.makeUnsafe("event-delete"),
      aggregateKind: "thread",
      aggregateId: threadId,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        threadIds: [threadId, childThreadId],
        deletedAt: "2026-01-01T00:00:02.000Z",
      },
    });

    expect(cache.getSnapshot()?.threads).toEqual([
      expect.objectContaining({ id: survivingChildThreadId }),
    ]);
    expect(cache.getThread()).toBeUndefined();
    expect(cache.getThread(childThreadId)).toBeUndefined();
    expect(cache.getThreadVariant()).toBeUndefined();
    expect(cache.getThreadVariant(childThreadId)).toBeUndefined();
    expect(cache.getThread(survivingChildThreadId)?.parentThread).toBeUndefined();
    expect(cache.invalidatedKeys).toContainEqual(["mobile-thread", sessionId]);
  });

  it("flushes queued non-immediate events during dispose", () => {
    const cache = makeQueryClient({
      snapshot: makeSnapshot(),
      thread: makeThread(),
    });
    const scheduler = {
      queueMicrotask: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    };
    const controller = createMobileOrchestrationSyncController({
      queryClient: cache.queryClient,
      sessionId,
      scheduler,
    });

    controller.queueEvent(makeMessageSentEvent({ text: "Done", streaming: false, sequence: 1 }));

    expect(cache.getThread()?.messages).toHaveLength(0);

    controller.dispose();

    expect(cache.getThread()?.messages[0]?.text).toBe("Done");
    expect(scheduler.clearTimeout).not.toHaveBeenCalled();
  });
});

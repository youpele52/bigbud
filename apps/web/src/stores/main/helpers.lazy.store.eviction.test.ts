import { EventId, MessageId, ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { Thread } from "../../models/types";
import { applyOrchestrationEvent } from "./events.store";
import {
  markThreadViewed,
  MAX_HYDRATED_THREADS,
  unloadHydratedThreads,
  invalidateInFlightThreadHydrations,
} from "./helpers.lazy.eviction.store";
import type { AppState } from "./main.store";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";

const AT = "2026-02-27T00:00:00.000Z";

function loadedThread(index: number): Thread {
  const id = ThreadId.makeUnsafe(`thread-${index}`);
  return makeThread({
    id,
    messages: [
      {
        id: MessageId.makeUnsafe(`message-${index}`),
        role: "user",
        text: "hi",
        createdAt: AT,
        streaming: false,
      },
    ],
    activities: [
      {
        id: EventId.makeUnsafe(`tool-${index}`),
        tone: "tool",
        kind: "tool.completed",
        summary: "Tool",
        payload: {},
        turnId: null,
        createdAt: AT,
      },
      {
        id: EventId.makeUnsafe(`approval-${index}`),
        tone: "approval",
        kind: "approval.requested",
        summary: "Approval",
        payload: { requestId: `request-${index}` },
        turnId: null,
        createdAt: AT,
      },
    ],
  });
}

function stateWithLoadedThreads(count: number): AppState {
  const threads = Array.from({ length: count }, (_, index) => loadedThread(index));
  const base = makeState(threads[0]!);
  return {
    ...base,
    threads,
    threadHydrationById: Object.fromEntries(
      threads.map((thread) => [thread.id, { status: "complete" } as const]),
    ),
  };
}

const threadAt = (state: AppState, index: number) =>
  state.threads.find((thread) => thread.id === `thread-${index}`)!;

/** Opening a thread hydrates it, then records the view (as the route does). */
function openThread(state: AppState, index: number): AppState {
  const thread = loadedThread(index);
  const hydrated: AppState = {
    ...state,
    threads: [...state.threads.filter((entry) => entry.id !== thread.id), thread],
    threadHydrationById: { ...state.threadHydrationById, [thread.id]: { status: "complete" } },
  };
  return markThreadViewed(hydrated, thread.id);
}

describe("hydrated thread eviction", () => {
  it("keeps full detail only for the most recently viewed threads", () => {
    let state = makeState(makeThread({ id: ThreadId.makeUnsafe("thread-unrelated") }));
    for (let index = 0; index <= MAX_HYDRATED_THREADS + 1; index += 1) {
      state = openThread(state, index);
    }

    expect(state.recentlyViewedThreadIds).toHaveLength(MAX_HYDRATED_THREADS);
    expect(state.recentlyViewedThreadIds?.[0]).toBe(`thread-${MAX_HYDRATED_THREADS + 1}`);
    for (const evicted of [0, 1]) {
      expect(state.threadHydrationById[`thread-${evicted}`]).toEqual({ status: "unloaded" });
      expect(threadAt(state, evicted).messages).toEqual([]);
      // The summary keeps what the sidebar derives pending requests from.
      expect(threadAt(state, evicted).activities.map((activity) => activity.kind)).toEqual([
        "approval.requested",
      ]);
    }
    for (let index = 2; index <= MAX_HYDRATED_THREADS + 1; index += 1) {
      expect(state.threadHydrationById[`thread-${index}`]).toEqual({ status: "complete" });
      expect(threadAt(state, index).messages).toHaveLength(1);
    }
    // A never-hydrated summary thread is untouched.
    expect(state.threadHydrationById["thread-unrelated"]).toBeUndefined();
  });

  it("re-viewing a thread moves it to the front instead of evicting it", () => {
    let state = makeState(makeThread({ id: ThreadId.makeUnsafe("thread-unrelated") }));
    for (let index = 0; index < MAX_HYDRATED_THREADS; index += 1) {
      state = openThread(state, index);
    }
    state = markThreadViewed(state, ThreadId.makeUnsafe("thread-0"));
    state = openThread(state, MAX_HYDRATED_THREADS);

    expect(state.threadHydrationById["thread-0"]).toEqual({ status: "complete" });
    expect(state.threadHydrationById["thread-1"]).toEqual({ status: "unloaded" });
  });

  it("leaves a thread with a request in flight alone", () => {
    let state = stateWithLoadedThreads(2);
    state = {
      ...state,
      threadHydrationById: { ...state.threadHydrationById, "thread-1": { status: "loadingOlder" } },
    };
    state = unloadHydratedThreads(state, ThreadId.makeUnsafe("thread-0"));

    expect(state.threadHydrationById["thread-1"]).toEqual({ status: "loadingOlder" });
    expect(threadAt(state, 1).messages).toHaveLength(1);
  });

  it.each(["loading", "loadingOlder"] as const)(
    "makes revoked %s requests reloadable without disturbing other hydration owners",
    (status) => {
      const base = stateWithLoadedThreads(2);
      const state = invalidateInFlightThreadHydrations({
        ...base,
        threadHydrationById: {
          ...base.threadHydrationById,
          "thread-0": { status },
          "thread-absent": { status },
        },
      });
      expect(state.threadHydrationById["thread-0"]).toEqual({ status: "unloaded" });
      expect(state.threadHydrationById["thread-absent"]).toEqual({ status: "unloaded" });
      expect(threadAt(state, 0).messages).toEqual([]);
      expect(threadAt(state, 0).activities.map((activity) => activity.kind)).toEqual([
        "approval.requested",
      ]);
      expect(state.threadHydrationById["thread-1"]).toBe(base.threadHydrationById["thread-1"]);
      expect(threadAt(state, 1)).toBe(threadAt(base, 1));
      expect(invalidateInFlightThreadHydrations(state)).toBe(state);
    },
  );

  it("marks every hydrated non-selected thread unloaded on a baseline reset", () => {
    const state = unloadHydratedThreads(stateWithLoadedThreads(3), ThreadId.makeUnsafe("thread-1"));

    expect(state.threadHydrationById["thread-0"]).toEqual({ status: "unloaded" });
    expect(state.threadHydrationById["thread-1"]).toEqual({ status: "complete" });
    expect(state.threadHydrationById["thread-2"]).toEqual({ status: "unloaded" });
    expect(threadAt(state, 1).messages).toHaveLength(1);
    expect(threadAt(state, 2).messages).toEqual([]);
  });
});

describe("live events for summary-only threads", () => {
  const summaryOnlyState = () => {
    const thread = makeThread({ id: ThreadId.makeUnsafe("thread-1") });
    const base = makeState(thread);
    return {
      ...base,
      threadHydrationById: { [thread.id]: { status: "unloaded" } as const },
      sidebarThreadsById: {
        [thread.id]: {
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          interactionMode: thread.interactionMode,
          session: null,
          createdAt: thread.createdAt,
          archivedAt: null,
          pinnedAt: null,
          updatedAt: AT,
          latestTurn: null,
          branch: null,
          worktreePath: null,
          latestUserMessageAt: "2026-02-26T00:00:00.000Z",
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      },
    } satisfies AppState;
  };

  it("updates the summary without storing the transcript", () => {
    const state = applyOrchestrationEvent(
      summaryOnlyState(),
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("message-new"),
        role: "user",
        text: "a new message",
        turnId: null,
        streaming: false,
        createdAt: AT,
        updatedAt: AT,
      }),
    );

    expect(state.threads[0]?.messages).toEqual([]);
    expect(state.sidebarThreadsById["thread-1"]?.latestUserMessageAt).toBe(AT);
  });

  it("keeps pending-request activities but drops work-log activities", () => {
    const activity = (id: string, kind: string) =>
      makeEvent("thread.activity-appended", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe(id),
          tone: "info",
          kind,
          summary: kind,
          payload: { requestId: "request-1" },
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: AT,
        },
      });
    let state: AppState = summaryOnlyState();
    state = applyOrchestrationEvent(state, activity("tool-1", "tool.completed"));
    state = applyOrchestrationEvent(state, activity("approval-1", "approval.requested"));

    expect(state.threads[0]?.activities.map((entry) => entry.id)).toEqual(["approval-1"]);
    expect(state.sidebarThreadsById["thread-1"]?.hasPendingApprovals).toBe(true);
  });
});

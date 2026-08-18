import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvent } from "./events.store";
import { buildSidebarThreadSummary } from "./mappers.store";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";

describe("thread deletion state", () => {
  it("removes deleted thread descendants from state and sidebar caches", () => {
    const rootThread = makeThread({ id: ThreadId.makeUnsafe("thread-root") });
    const descendantThread = makeThread({ id: ThreadId.makeUnsafe("thread-descendant") });
    const retainedThread = makeThread({ id: ThreadId.makeUnsafe("thread-retained") });
    const state = {
      ...makeState(rootThread),
      threads: [rootThread, descendantThread, retainedThread],
      sidebarThreadsById: {
        [rootThread.id]: buildSidebarThreadSummary(rootThread),
        [descendantThread.id]: buildSidebarThreadSummary(descendantThread),
        [retainedThread.id]: buildSidebarThreadSummary(retainedThread),
      },
      threadIdsByProjectId: {
        [rootThread.projectId]: [rootThread.id, descendantThread.id, retainedThread.id],
      },
      threadHydrationById: {
        [rootThread.id]: { status: "complete" as const },
        [descendantThread.id]: { status: "complete" as const },
        [retainedThread.id]: { status: "complete" as const },
      },
      sidebarRecentThreadIds: [rootThread.id, descendantThread.id, retainedThread.id],
      sidebarPinnedThreadIds: [descendantThread.id, retainedThread.id],
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: rootThread.id,
        threadIds: [rootThread.id, descendantThread.id],
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads).toEqual([retainedThread]);
    expect(next.sidebarThreadsById).toEqual({
      [retainedThread.id]: buildSidebarThreadSummary(retainedThread),
    });
    expect(next.threadIdsByProjectId[rootThread.projectId]).toEqual([retainedThread.id]);
    expect(next.threadHydrationById).toEqual({ [retainedThread.id]: { status: "complete" } });
    expect(next.sidebarRecentThreadIds).toEqual([retainedThread.id]);
    expect(next.sidebarPinnedThreadIds).toEqual([retainedThread.id]);
  });
});

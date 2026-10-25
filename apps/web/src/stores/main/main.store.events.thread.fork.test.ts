import { ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvent } from "./events.store";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";

const source = makeThread();
const created = (forkOrigin?: unknown) =>
  makeEvent("thread.created", {
    threadId: ThreadId.makeUnsafe("fork-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    parentThread: { threadId: source.id, title: source.title },
    ...(forkOrigin ? { forkOrigin } : {}),
    createdAt: "2026-10-15T10:00:00.000Z",
    updatedAt: "2026-10-15T10:00:00.000Z",
  } as never);

describe("server-side fork threads in the web store", () => {
  it("keeps the fork origin and starts with a held queue when the pending prompt is held", () => {
    const forkOrigin = {
      forkPointMessageId: null,
      reason: "recovery-failed",
      failureEventId: null,
      pendingDelivery: "held",
    };
    const next = applyOrchestrationEvent(makeState(source), created(forkOrigin));
    const fork = next.threads.find((thread) => thread.id === "fork-1");
    expect(fork?.forkOrigin).toEqual(forkOrigin);
    expect(fork?.queueHold).toBe(true);
    expect(fork?.parentThread?.threadId).toBe(source.id);
  });

  it("leaves ordinary created threads unchanged", () => {
    const next = applyOrchestrationEvent(makeState(source), created());
    const thread = next.threads.find((entry) => entry.id === "fork-1");
    expect(thread?.forkOrigin).toBeUndefined();
    expect(thread?.queueHold ?? false).toBe(false);
  });
});

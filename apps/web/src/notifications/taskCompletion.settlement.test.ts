import { describe, expect, it } from "vitest";
import { hasUnsettledCurrentRunWork } from "../logic/thread/threadBackgroundWork.logic";
import {
  collectCompletedThreadCandidates,
  collectAgentUpdateCandidates,
  buildTaskCompletionCopy,
} from "./taskCompletion.logic";
import { observeThreadNotification } from "./taskCompletion.observations";
import { observeNotificationSafety } from "./taskCompletion.safety";
import { mergeNotificationTasks } from "./taskCompletion.tasks";
import {
  makeAgent,
  makeNotificationThread,
  notificationEvent,
  now,
} from "./taskCompletion.test.helpers";

function messageEvent(id: string, text: string, streaming = false, replace = false) {
  return notificationEvent("thread.message-sent", {
    threadId: "thread-1",
    messageId: id,
    role: "assistant",
    turnId: "turn-1",
    text,
    streaming,
    replace,
    createdAt: now,
    updatedAt: now,
  });
}

describe("live progress observations", () => {
  it("emits each finished message as an update without claiming run completion", () => {
    const previous = makeNotificationThread({
      notificationObservation: { messages: [] },
      latestTurn: null,
    });
    const first = observeThreadNotification(
      previous,
      previous,
      messageEvent("m1", "Still working"),
    );
    const next = observeThreadNotification(first, first, messageEvent("m2", "More progress"));
    const candidates = collectAgentUpdateCandidates([previous], [next]);
    expect(candidates).toHaveLength(2);
    expect(candidates.map(buildTaskCompletionCopy).map((copy) => copy.title)).toEqual([
      "Agent update",
      "Agent update",
    ]);
    expect(collectCompletedThreadCandidates([previous], [next])).toEqual([]);
    expect(collectAgentUpdateCandidates([next], [next])).toEqual([]);
  });

  it("retains an empty final's streamed preview and honors replace", () => {
    const previous = makeNotificationThread({ notificationObservation: { messages: [] } });
    let next = observeThreadNotification(previous, previous, messageEvent("m", "Old", true));
    next = observeThreadNotification(next, next, messageEvent("m", "Replacement", true, true));
    next = observeThreadNotification(next, next, messageEvent("m", ""));
    expect(collectAgentUpdateCandidates([previous], [next])[0]?.assistantSummary).toBe(
      "Replacement",
    );
    const duplicate = observeThreadNotification(next, next, messageEvent("m", ""));
    expect(collectAgentUpdateCandidates([next], [duplicate])).toEqual([]);
  });

  it("does not turn hydrated history into a live update", () => {
    const previous = makeNotificationThread({
      notificationObservation: { messages: [] },
      messages: [
        {
          id: "m" as never,
          role: "assistant",
          text: "Historical",
          turnId: "turn-1" as never,
          streaming: false,
          createdAt: now,
          completedAt: now,
        },
      ],
    });
    const next = observeThreadNotification(previous, previous, messageEvent("m", "Historical"));
    expect(collectAgentUpdateCandidates([previous], [next])).toEqual([]);
  });

  it("bounds observations and preview memory", () => {
    let next = makeNotificationThread({ notificationObservation: { messages: [] } });
    for (let i = 0; i < 80; i++)
      next = observeThreadNotification(next, next, messageEvent(`m${i}`, "x".repeat(500)));
    expect(next.notificationObservation?.messages).toHaveLength(32);
    expect(
      next.notificationObservation?.messages.every((message) => message.text.length <= 140),
    ).toBe(true);
  });
});

describe("native successful settlement safety", () => {
  it.each(["failed", "interrupted", "cancelled"] as const)(
    "does not report %s as success",
    (terminalOutcome) => {
      const next = makeNotificationThread();
      next.latestTurn = { ...next.latestTurn!, terminalOutcome };
      expect(
        collectCompletedThreadCandidates([makeNotificationThread({ latestTurn: null })], [next]),
      ).toEqual([]);
    },
  );

  it("requires live proof, not hydrated completion", () => {
    const next = makeNotificationThread({ notificationObservation: { messages: [] } });
    expect(
      collectCompletedThreadCandidates([makeNotificationThread({ latestTurn: null })], [next]),
    ).toEqual([]);
  });

  it.each(["pending", "inProgress", "failed", "stopped"] as const)(
    "blocks an owned %s task",
    (status) => {
      const next = makeNotificationThread({ providerAgents: [makeAgent({ status })] });
      expect(hasUnsettledCurrentRunWork(next)).toBe(true);
    },
  );

  it("does not lose task evidence behind an empty live list", () => {
    const next = makeNotificationThread({ providerAgents: [] });
    next.notificationSafety = { ...next.notificationSafety!, tasks: [makeAgent()] };
    expect(hasUnsettledCurrentRunWork(next)).toBe(true);
    const completed = makeAgent({
      status: "completed",
      freshness: { sessionEpoch: "epoch-1", sourcePriority: 1, observedOrdinal: 2 },
    });
    next.providerAgents = [completed];
    expect(hasUnsettledCurrentRunWork(next)).toBe(false);
    expect(mergeNotificationTasks([completed], [makeAgent()])).toEqual([completed]);
  });

  it("does not infer success from removal of unfinished work", () => {
    const previous = makeNotificationThread({ providerAgents: [makeAgent()] });
    const next = observeThreadNotification(
      previous,
      { ...previous, providerAgents: [] },
      notificationEvent("thread.task-removed", { taskId: "agent-1" }),
    );
    expect(hasUnsettledCurrentRunWork(next)).toBe(true);
  });

  it("waits for a child's descendants even when the parent object has not changed", () => {
    const parent = makeNotificationThread();
    parent.notificationSafety = {
      ...parent.notificationSafety!,
      childThreadIds: ["child" as never],
      childTurns: [
        {
          threadId: "child" as never,
          turnId: "turn-1" as never,
          requestMessageId: "request" as never,
          sessionEpoch: 0,
        },
      ],
    };
    const child = makeNotificationThread({
      id: "child" as never,
      purpose: "standard",
      providerAgents: [makeAgent()],
    });
    const childDone = { ...child, providerAgents: [makeAgent({ status: "completed" })] };
    expect(collectCompletedThreadCandidates([parent, child], [parent, child])).toEqual([]);
    expect(
      collectCompletedThreadCandidates([parent, child], [parent, childDone]).map(
        (candidate) => candidate.threadId,
      ),
    ).toContain(parent.id);
    expect(hasUnsettledCurrentRunWork(parent)).toBe(true);
    child.notificationSafety = { ...child.notificationSafety!, childThreadIds: [parent.id] };
    expect(
      hasUnsettledCurrentRunWork(
        parent,
        new Map([
          [parent.id, parent],
          [child.id, child],
        ]),
      ),
    ).toBe(true);
  });

  it("ignores historical agents from a different run", () => {
    expect(
      hasUnsettledCurrentRunWork(
        makeNotificationThread({ providerAgents: [makeAgent({ turnId: "old" as never })] }),
      ),
    ).toBe(false);
  });

  it("blocks pending request, queue, overflow and plan evidence without a transcript", () => {
    for (const patch of [
      { pendingRequestIds: ["request"] },
      { queuedPromptIds: ["message" as never] },
      { overflow: true },
    ]) {
      const thread = makeNotificationThread();
      thread.notificationSafety = { ...thread.notificationSafety!, ...patch };
      expect(hasUnsettledCurrentRunWork(thread)).toBe(true);
    }
    const plan = makeNotificationThread({ interactionMode: "plan" });
    plan.notificationSafety = { ...plan.notificationSafety!, hasActionablePlan: true };
    expect(hasUnsettledCurrentRunWork(plan)).toBe(true);
  });

  it("resolves summary-only request evidence with a live canonical resolution", () => {
    const previous = makeNotificationThread();
    previous.notificationSafety = {
      ...previous.notificationSafety!,
      pendingRequestIds: ["request"],
    };
    const next = observeNotificationSafety(
      previous,
      previous,
      notificationEvent("thread.activity-appended", {
        activity: { kind: "approval.resolved", payload: { requestId: "request" } },
      }),
    );
    expect(hasUnsettledCurrentRunWork(previous)).toBe(true);
    expect(hasUnsettledCurrentRunWork(next)).toBe(false);
  });

  it("does not clear truncated thread-level evidence when a fresh run starts", () => {
    const previous = makeNotificationThread();
    previous.notificationSafety = {
      ...previous.notificationSafety!,
      overflow: true,
      pendingRequestIds: Array.from({ length: 100 }, (_, i) => `r${i}`),
    };
    const next = observeNotificationSafety(
      previous,
      { ...previous, latestTurn: { ...previous.latestTurn!, turnId: "new" as never } },
      notificationEvent("thread.session-set", { session: { status: "running" } }),
    );
    expect(next.notificationSafety?.overflow).toBe(true);
  });
});

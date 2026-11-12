import { describe, expect, it } from "vitest";
import { applyOrchestrationEvent } from "../stores/main/events.store";
import { makeState } from "../stores/main/main.store.test.helpers";
import { hasUnsettledCurrentRunWork } from "../logic/thread/threadBackgroundWork.logic";
import { collectCompletedThreadCandidates } from "./taskCompletion.logic";
import { makeNotificationThread, notificationEvent, now } from "./taskCompletion.test.helpers";

function binding(turnId = "native-child", sessionEpoch = 7, messageId = "source-request") {
  return {
    ...notificationEvent("thread.activity-appended", {
      threadId: "child",
      activity: {
        id: `bound-${turnId}`,
        kind: "text-generation.user-turn-bound",
        tone: "info",
        summary: "Submitted",
        turnId,
        createdAt: now,
        payload: { messageId, sessionEpoch, providerIdle: false },
      },
    }),
    sequence: 12,
  };
}

function setup() {
  const parent = makeNotificationThread();
  const child = makeNotificationThread({
    id: "child" as never,
    notificationObservation: { messages: [] },
    session: {
      provider: "codex",
      status: "ready",
      orchestrationStatus: "ready",
      sessionEpoch: 7,
      createdAt: now,
      updatedAt: now,
    },
  });
  const { terminalOutcome: _outcome, ...latestTurn } = child.latestTurn!;
  child.latestTurn = { ...latestTurn, turnId: "native-child" as never };
  child.notificationSafety = { ...child.notificationSafety!, turnId: "native-child" as never };
  let state = { ...makeState(parent), threads: [parent, child] };
  state = applyOrchestrationEvent(state, {
    ...notificationEvent("thread.activity-appended", {
      threadId: parent.id,
      activity: {
        id: "linked",
        kind: "delegation.child-linked",
        turnId: null,
        tone: "info",
        summary: "Linked",
        createdAt: now,
        payload: { childThreadId: child.id, requestMessageId: "source-request" },
      },
    }),
    sequence: 11,
  });
  return state;
}

describe("delegated native turn authority", () => {
  it.each([true, false])(
    "releases parent once for exact child settlement (binding first: %s)",
    (bindingFirst) => {
      const initial = setup();
      expect(initial.threads[0]?.notificationSafety?.childTurns?.[0]?.turnId).toBeNull();
      const settle = {
        ...notificationEvent("thread.turn-settled", {
          threadId: "child",
          turnId: "native-child",
          sessionEpoch: 7,
          outcome: "completed",
          completedAt: now,
        }),
        sequence: 13,
      };
      const middle = applyOrchestrationEvent(initial, bindingFirst ? binding() : settle);
      expect(
        collectCompletedThreadCandidates(initial.threads, middle.threads).filter(
          (candidate) => candidate.threadId === "thread-1",
        ),
      ).toEqual([]);
      const done = applyOrchestrationEvent(middle, bindingFirst ? settle : binding());
      expect(done.threads[0]?.notificationSafety?.childTurns?.[0]).toMatchObject({
        turnId: "native-child",
        sessionEpoch: 7,
        requestMessageId: "source-request",
      });
      expect(
        collectCompletedThreadCandidates(middle.threads, done.threads).filter(
          (candidate) => candidate.threadId === "thread-1",
        ),
      ).toHaveLength(1);
      const duplicate = applyOrchestrationEvent(done, binding());
      expect(collectCompletedThreadCandidates(done.threads, duplicate.threads)).toEqual([]);
      const retried = applyOrchestrationEvent(done, binding("later-native", 8));
      expect(retried.threads[0]?.notificationSafety?.childTurns?.[0]?.turnId).toBe("native-child");
      const child = retried.threads[1]!;
      for (const changed of [
        { ...child, latestTurn: { ...child.latestTurn!, turnId: "later-native" as never } },
        { ...child, session: { ...child.session!, sessionEpoch: 8 } },
      ])
        expect(
          hasUnsettledCurrentRunWork(retried.threads[0]!, new Map([[child.id, changed]])),
        ).toBe(true);
    },
  );

  it("cannot bind another request or the reservation, including with an unloaded child", () => {
    const initial = setup();
    const wrong = applyOrchestrationEvent(initial, binding("reserved-child", 7, "other-request"));
    expect(wrong.threads[0]?.notificationSafety?.childTurns?.[0]?.turnId).toBeNull();
    const unloaded = { ...initial, threads: [initial.threads[0]!] };
    const bound = applyOrchestrationEvent(unloaded, binding());
    expect(bound.threads[0]?.notificationSafety?.childTurns?.[0]?.turnId).toBe("native-child");
    expect(hasUnsettledCurrentRunWork(bound.threads[0]!)).toBe(true);
  });
});

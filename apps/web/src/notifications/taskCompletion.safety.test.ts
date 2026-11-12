import { describe, expect, it } from "vitest";
import { hasUnsettledCurrentRunWork } from "../logic/thread/threadBackgroundWork.logic";
import { mergeThreadSummary } from "../stores/main/helpers.lazy.summaries.store";
import { applyThreadReverted } from "../stores/main/helpers.store";
import { observeNotificationSafety } from "./taskCompletion.safety";
import { mergeNotificationTasks } from "./taskCompletion.tasks";
import {
  makeAgent,
  makeNotificationThread,
  notificationEvent,
} from "./taskCompletion.test.helpers";

describe("notification safety ordering and control evidence", () => {
  it("rejects older summary evidence before it can release a live safety gate", () => {
    const thread = makeNotificationThread({ notificationSafetySequence: 20 });
    thread.notificationSafety = { ...thread.notificationSafety!, pendingRequestIds: ["pending"] };
    // The stale payload must not even be decoded or merged.
    expect(mergeThreadSummary(thread, {} as never, 19)).toBe(thread);
    expect(hasUnsettledCurrentRunWork(thread)).toBe(true);
  });

  it("does not trust wall clocks to order conflicting session epochs", () => {
    const completed = makeAgent({ status: "completed", updatedAt: "2099-01-01T00:00:00.000Z" });
    const unresolved = makeAgent({
      freshness: { sessionEpoch: "other", sourcePriority: 1, observedOrdinal: 100 },
    });
    expect(mergeNotificationTasks([completed], [unresolved])).toEqual([unresolved]);
    expect(mergeNotificationTasks([unresolved], [completed])).toEqual([unresolved]);
  });

  it("blocks pending start intent and clears it only for the matching failed start", () => {
    const thread = makeNotificationThread();
    const pending = observeNotificationSafety(
      thread,
      thread,
      notificationEvent("thread.turn-start-requested", { messageId: "starting" }),
    );
    expect(hasUnsettledCurrentRunWork(pending)).toBe(true);
    const stale = observeNotificationSafety(
      pending,
      pending,
      notificationEvent("thread.turn-start-failed", { messageId: "other" }),
    );
    expect(hasUnsettledCurrentRunWork(stale)).toBe(true);
    const cleared = observeNotificationSafety(
      stale,
      stale,
      notificationEvent("thread.turn-start-failed", { messageId: "starting" }),
    );
    expect(hasUnsettledCurrentRunWork(cleared)).toBe(false);
  });

  it("keeps interrupt-flush intent until matching cancellation or exact flush", () => {
    const thread = makeNotificationThread();
    thread.notificationSafety = {
      ...thread.notificationSafety!,
      pendingFlush: {
        intentId: "flush",
        queuedPromptIds: ["a" as never, "b" as never],
      },
    };
    const partial = observeNotificationSafety(
      thread,
      thread,
      notificationEvent("thread.queued-prompts-flushed", { messageIds: ["a"] }),
    );
    expect(hasUnsettledCurrentRunWork(partial)).toBe(true);
    const stale = observeNotificationSafety(
      partial,
      partial,
      notificationEvent("thread.queued-prompt-flush-cancelled", { intentId: "other" }),
    );
    expect(hasUnsettledCurrentRunWork(stale)).toBe(true);
    const cleared = observeNotificationSafety(
      stale,
      stale,
      notificationEvent("thread.queued-prompt-flush-cancelled", { intentId: "flush" }),
    );
    expect(hasUnsettledCurrentRunWork(cleared)).toBe(false);
    const flushed = observeNotificationSafety(
      thread,
      thread,
      notificationEvent("thread.queued-prompts-flushed", { messageIds: ["a", "b"] }),
    );
    expect(hasUnsettledCurrentRunWork(flushed)).toBe(false);
  });

  it("does not substitute another child run's success for the delegated turn", () => {
    const parent = makeNotificationThread();
    parent.notificationSafety = {
      ...parent.notificationSafety!,
      childThreadIds: ["child" as never],
      childTurns: [
        {
          threadId: "child" as never,
          turnId: "delegated-turn" as never,
          requestMessageId: "request" as never,
          sessionEpoch: 0,
        },
      ],
    };
    const child = makeNotificationThread({ id: "child" as never });
    expect(hasUnsettledCurrentRunWork(parent, new Map([[child.id, child]]))).toBe(true);
    child.latestTurn = { ...child.latestTurn!, turnId: "delegated-turn" as never };
    child.notificationSafety = { ...child.notificationSafety!, turnId: "delegated-turn" as never };
    expect(hasUnsettledCurrentRunWork(parent, new Map([[child.id, child]]))).toBe(false);
  });

  it("retains unscoped current-run delegation links until exact child proof is available", () => {
    const thread = makeNotificationThread();
    const linked = observeNotificationSafety(
      thread,
      thread,
      notificationEvent("thread.activity-appended", {
        activity: {
          kind: "delegation.child-linked",
          turnId: null,
          createdAt: thread.createdAt,
          payload: { childThreadId: "child" },
        },
      }),
    );
    expect(linked.notificationSafety?.childThreadIds).toEqual(["child"]);
    expect(hasUnsettledCurrentRunWork(linked)).toBe(true);
    const child = makeNotificationThread({ id: "child" as never });
    expect(hasUnsettledCurrentRunWork(linked, new Map([[child.id, child]]))).toBe(true);
  });

  it("initializes safety from loaded tasks without lowering the catalog sequence fence", () => {
    const thread = makeNotificationThread({
      providerAgents: [makeAgent()],
      notificationSafetySequence: 20,
    });
    delete thread.notificationSafety;
    const next = observeNotificationSafety(
      thread,
      thread,
      notificationEvent("thread.queued-prompt-removed", { messageId: "absent" }),
    );
    expect(next.notificationSafety?.tasks).toEqual(thread.providerAgents);
    expect(next.notificationSafetySequence).toBe(20);
    expect(hasUnsettledCurrentRunWork(next)).toBe(true);
  });

  it("preserves same-run proof through a client revert without promoting checkpoint history", () => {
    const thread = makeNotificationThread();
    const checkpoint = {
      turnId: thread.latestTurn!.turnId,
      completedAt: thread.createdAt,
      checkpointTurnCount: 1,
      status: "ready",
      files: [],
    };
    const retained = applyThreadReverted(
      { ...thread, turnDiffSummaries: [checkpoint] },
      { turnCount: 1, occurredAt: thread.createdAt },
    );
    expect(retained.latestTurn).toEqual(thread.latestTurn);
    const historical = applyThreadReverted(
      { ...thread, turnDiffSummaries: [{ ...checkpoint, turnId: "earlier" as never }] },
      { turnCount: 1, occurredAt: thread.createdAt },
    );
    expect(historical.latestTurn?.turnId).toBe("earlier");
    expect(historical.latestTurn?.terminalOutcome).toBeUndefined();
  });

  it("does not let another implemented plan clear summary-only current actionable work", () => {
    const thread = makeNotificationThread({ interactionMode: "plan" });
    thread.notificationSafety = { ...thread.notificationSafety!, hasActionablePlan: true };
    const next = observeNotificationSafety(
      thread,
      thread,
      notificationEvent("thread.proposed-plan-upserted", {
        proposedPlan: { id: "historical", turnId: "older", implementedAt: thread.createdAt },
      }),
    );
    expect(hasUnsettledCurrentRunWork(next)).toBe(true);
  });

  it("fails closed when safety evidence belongs to another root run", () => {
    const thread = makeNotificationThread();
    thread.notificationSafety = { ...thread.notificationSafety!, turnId: "older" as never };
    expect(hasUnsettledCurrentRunWork(thread)).toBe(true);
  });
});

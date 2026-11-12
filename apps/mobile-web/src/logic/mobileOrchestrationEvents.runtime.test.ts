import { makeThread } from "./mobileOrchestrationEvents.test.helpers";
import { describe, expect, it } from "vitest";
import {
  type OrchestrationThread,
  type OrchestrationEvent,
  ThreadId,
  TurnId,
  MessageId,
} from "@bigbud/contracts";
import { applyMobileSession, applyMobileSettlement } from "./mobileOrchestrationEvents.runtime";
import { buildThreadMessageLatestTurn } from "./mobileOrchestrationEvents.helpers";
const now = "2026-11-12T02:00:00.000Z";
const id = ThreadId.makeUnsafe("thread");
const turnId = TurnId.makeUnsafe("turn");
function thread(): OrchestrationThread {
  return makeThread({
    id,
    deletedAt: null,
    messages: [],
    session: session(1).payload.session,
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      assistantMessageId: MessageId.makeUnsafe("assistant"),
      sourceProposedPlan: { threadId: id, planId: "plan" },
    },
  });
}
function settle(outcome = "completed", overrides: object = {}) {
  return {
    type: "thread.turn-settled",
    occurredAt: now,
    payload: { threadId: id, turnId, sessionEpoch: 1, completedAt: now, outcome, ...overrides },
  } as Extract<OrchestrationEvent, { type: "thread.turn-settled" }>;
}
function session(epoch: number) {
  return {
    type: "thread.session-set",
    occurredAt: now,
    payload: {
      threadId: id,
      session: {
        status: "running",
        sessionEpoch: epoch,
        activeTurnId: turnId,
        reason: null,
        updatedAt: now,
      },
    },
  } as Extract<OrchestrationEvent, { type: "thread.session-set" }>;
}
describe("mobile native turn settlement", () => {
  it.each([
    ["completed", "completed"],
    ["failed", "error"],
    ["interrupted", "interrupted"],
    ["cancelled", "interrupted"],
  ])("maps %s without losing turn identity", (outcome, state) => {
    const before = thread();
    const next = applyMobileSettlement(before, settle(outcome))!;
    expect(next.latestTurn).toMatchObject({
      ...before.latestTurn,
      state,
      terminalOutcome: outcome,
      completedAt: now,
    });
    expect(applyMobileSettlement(next, settle("failed"))).toBe(next);
  });
  it.each([
    { threadId: ThreadId.makeUnsafe("other") },
    { turnId: TurnId.makeUnsafe("other") },
    { sessionEpoch: 0 },
  ])("rejects foreign/stale settlement %j", (overrides) => {
    const before = thread();
    const next = applyMobileSettlement(before, settle("completed", overrides));
    expect(next === null || next === before).toBe(true);
  });
  it("preserves proof across late messages and same epoch; newer epoch stays running", () => {
    const settled = applyMobileSettlement(thread(), settle())!;
    for (const streaming of [true, false]) {
      const event = {
        type: "thread.message-sent",
        payload: {
          role: "assistant",
          turnId,
          messageId: MessageId.makeUnsafe("late"),
          streaming,
          createdAt: now,
          updatedAt: now,
        },
      } as Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
      expect(buildThreadMessageLatestTurn(settled, event)).toMatchObject({
        terminalOutcome: "completed",
        completedAt: now,
        state: "completed",
      });
    }
    expect(applyMobileSession(settled, session(1))?.session?.status).toBe("ready");
    const newer = applyMobileSession(settled, session(2));
    expect(newer?.session?.status).toBe("running");
    expect(newer?.latestTurn?.terminalOutcome).toBeUndefined();
    expect(newer?.latestTurn?.completedAt).toBeNull();
  });
});

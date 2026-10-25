import { MessageId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { USER_TURN_BOUND } from "@bigbud/shared/internalTextGeneration";
import { describe, expect, it } from "vitest";

import { readModel, threadId } from "./deciderThreads.turn.queue.test.helpers.ts";
import { makeEvent } from "./projector.test.helpers.ts";
import {
  canUserReleasePendingTurnStart,
  makeOrphanedPendingTurnStartCommand,
  mayChangePendingTurnStart,
  nextPendingTurnStart,
} from "./PendingTurnStart.logic.ts";
import { isThreadConfirmedIdleForDispatch } from "./ThreadDispatchSafety.logic.ts";

const now = "2026-08-01T00:00:00.000Z";
const pending = { messageId: MessageId.makeUnsafe("message-ab"), requestedAt: now };

const event = (type: OrchestrationEvent["type"], payload: unknown) =>
  makeEvent({
    sequence: 1,
    type,
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: null,
    payload: { threadId, ...(payload as object) },
  });

const sessionSet = (status: string, activeTurnId: string | null = null) =>
  event("thread.session-set", {
    session: { threadId, status, providerName: "codex", activeTurnId, lastError: null },
  });

const bound = (messageId: string, providerIdle?: boolean) =>
  event("thread.activity-appended", {
    activity: {
      kind: USER_TURN_BOUND,
      payload: { messageId, ...(providerIdle === undefined ? {} : { providerIdle }) },
      turnId: "turn-ab",
    },
  });
const failed = (messageId?: string) =>
  event("thread.turn-start-failed", {
    detail: "x",
    createdAt: now,
    ...(messageId === undefined ? {} : { messageId }),
  });
const requeued = (id: string, alreadySent = true) =>
  event("thread.prompt-queued", { prompt: { id, alreadySent } });

describe("nextPendingTurnStart", () => {
  it("opens on a turn start request", () => {
    expect(
      nextPendingTurnStart(
        null,
        event("thread.turn-start-requested", { messageId: "m", createdAt: now }),
      ),
    ).toEqual({ messageId: "m", requestedAt: now, requestedSequence: 1 });
  });

  it.each(["starting", "ready", "idle", "interrupted"])(
    "stays open when the session reports %s without a turn",
    (status) => {
      expect(nextPendingTurnStart(pending, sessionSet(status))).toBeUndefined();
    },
  );

  it.each([
    ["a bound turn", sessionSet("running", "turn-ab")],
    ["a stopped session", sessionSet("stopped")],
    ["an errored session", sessionSet("error")],
    ["its own failed start", failed("message-ab")],
    ["a failed start recorded before failures carried a message", failed()],
    ["a user stop", event("thread.session-stop-requested", { createdAt: now })],
    ["a busy re-queue", requeued("message-ab")],
    ["the idle provider accepting the message", bound("message-ab", true)],
    ["an acceptance recorded before the idle flag existed", bound("message-ab")],
  ])("closes on %s", (_label, closing) => {
    expect(nextPendingTurnStart(pending, closing)).toBeNull();
  });

  it.each([
    ["another message's failed start", failed("other")],
    ["another message being re-queued", requeued("other")],
    ["another message being bound", bound("other")],
    ["acceptance while the provider still runs the turn", bound("message-ab", false)],
  ])("stays open on %s", (_label, other) => {
    expect(nextPendingTurnStart(pending, other)).toBeUndefined();
  });

  it("only reads the thread for events that can move the gate", () => {
    expect(mayChangePendingTurnStart(sessionSet("ready"))).toBe(false);
    expect(mayChangePendingTurnStart(sessionSet("running", "turn-ab"))).toBe(true);
    expect(mayChangePendingTurnStart(requeued("message-ab", false))).toBe(false);
    expect(
      mayChangePendingTurnStart(
        event("thread.activity-appended", { activity: { kind: "tool.started", payload: {} } }),
      ),
    ).toBe(false);
    expect(mayChangePendingTurnStart(bound("message-ab", false))).toBe(false);
  });
});

describe("Send now past a stale pending start", () => {
  it("is allowed only after the gate has held the queue for two minutes", () => {
    const thread = readModel({ pendingTurnStart: pending }).threads[0]!;
    expect(canUserReleasePendingTurnStart(thread, "2026-08-01T00:01:59.000Z")).toBe(false);
    expect(canUserReleasePendingTurnStart(thread, "2026-08-01T00:02:00.000Z")).toBe(true);
    expect(canUserReleasePendingTurnStart(thread, "not a time")).toBe(false);
  });
});

describe("pending-start dispatch gate", () => {
  it("treats a ready session with a pending start as busy", () => {
    const thread = readModel({
      pendingTurnStart: pending,
      session: {
        threadId,
        status: "ready",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    }).threads[0]!;
    expect(isThreadConfirmedIdleForDispatch(thread)).toBe(false);
    expect(isThreadConfirmedIdleForDispatch({ ...thread, pendingTurnStart: null })).toBe(true);
  });

  it("settles an orphaned start found at startup as a stopped session", () => {
    const thread = readModel({
      pendingTurnStart: pending,
      session: {
        threadId,
        status: "ready",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        sessionEpoch: 3,
        lastError: null,
        updatedAt: now,
      },
    }).threads[0]!;
    expect(makeOrphanedPendingTurnStartCommand({ thread, createdAt: now })).toMatchObject({
      type: "thread.session.set",
      session: { status: "stopped", activeTurnId: null, sessionEpoch: 3 },
      expectedSessionEpoch: 3,
    });
    expect(
      makeOrphanedPendingTurnStartCommand({
        thread: { ...thread, pendingTurnStart: null },
        createdAt: now,
      }),
    ).toBeNull();
  });
});

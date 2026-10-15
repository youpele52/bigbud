import { MessageId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvents } from "./events.store";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";

const thread = makeThread();
const messageId = MessageId.makeUnsafe("user-1");
const requested = makeEvent("thread.turn-start-requested", {
  threadId: thread.id,
  messageId,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-10-15T10:00:00.000Z",
});
const session = (status: "running" | "ready", activeTurnId: string | null) =>
  makeEvent(
    "thread.session-set",
    {
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: activeTurnId === null ? null : TurnId.makeUnsafe(activeTurnId),
        sessionEpoch: 1,
        reason: null,
        lastError: null,
        updatedAt: "2026-10-15T10:00:07.000Z",
      },
    },
    { occurredAt: "2026-10-15T10:00:07.000Z" },
  );
const request = (events: Parameters<typeof applyOrchestrationEvents>[1]) =>
  applyOrchestrationEvents(makeState(thread), events).threads[0]?.turnStartRequest;

describe("turn-start request tracking for the reconnecting notice", () => {
  it("records a pending request", () => {
    expect(request([requested])).toEqual({
      messageId,
      requestedAt: "2026-10-15T10:00:00.000Z",
      outcome: "pending",
      settledAt: null,
    });
  });

  it("settles as started when the session runs a turn, not when it is merely ready", () => {
    expect(request([requested, session("ready", null)])?.outcome).toBe("pending");
    expect(request([requested, session("running", "turn-1")])).toMatchObject({
      outcome: "started",
      settledAt: "2026-10-15T10:00:07.000Z",
    });
  });

  it("settles as failed on thread.turn-start-failed", () => {
    const failed = makeEvent(
      "thread.turn-start-failed",
      {
        threadId: thread.id,
        context: "provider-turn-start",
        detail: "Provider session closed.",
        failureClass: "session-dead",
        createdAt: "2026-10-15T10:00:00.000Z",
      },
      { occurredAt: "2026-10-15T10:00:09.000Z" },
    );
    expect(request([requested, failed])?.outcome).toBe("failed");
  });

  it("drops the pending request when it is re-queued as a prompt or interrupted", () => {
    const queued = makeEvent("thread.prompt-queued", {
      threadId: thread.id,
      prompt: { id: messageId, text: "hello", createdAt: "2026-10-15T10:00:01.000Z" },
      queuePosition: 1,
    });
    expect(request([requested, queued])).toBeNull();
    const otherQueued = makeEvent("thread.prompt-queued", {
      threadId: thread.id,
      prompt: {
        id: MessageId.makeUnsafe("user-2"),
        text: "later",
        createdAt: "2026-10-15T10:00:01.000Z",
      },
      queuePosition: 1,
    });
    expect(request([requested, otherQueued])?.outcome).toBe("pending");
    const interrupt = makeEvent("thread.turn-interrupt-requested", {
      threadId: thread.id,
      createdAt: "2026-10-15T10:00:02.000Z",
    });
    expect(request([requested, interrupt])).toBeNull();
  });
});

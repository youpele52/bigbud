import { CommandId, MessageId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  apply,
  applyWithLifecycleFlush,
  interruptContinuationRequested,
  queuedIds,
  sessionSet,
  thread,
  threadId,
  userTurnBound,
} from "./PendingTurnStart.test.helpers.ts";

const now = "2026-08-01T00:00:00.000Z";

/** The a+b continuation turn is requested and its new provider session is starting. */
async function continuationSessionStarting(): Promise<OrchestrationReadModel> {
  const requested = await interruptContinuationRequested();
  const starting = await applyWithLifecycleFlush(
    requested,
    sessionSet(requested, "starting", null, { advanceSessionEpoch: true }),
  );
  expect(starting.flushed).toBe(false);
  return starting.model;
}

/** Then the session is bound but the turn is not: the state that used to flush `queued-c`. */
async function continuationSessionReady(): Promise<OrchestrationReadModel> {
  const starting = await continuationSessionStarting();
  const ready = await applyWithLifecycleFlush(starting, sessionSet(starting, "ready"));
  expect(ready.flushed).toBe(false);
  return ready.model;
}

const continuationMessageId = (model: OrchestrationReadModel) =>
  thread(model).pendingTurnStart!.messageId;

describe("queued prompts behind a requested but unbound turn", () => {
  let ready: OrchestrationReadModel;

  beforeEach(async () => {
    ready = await continuationSessionReady();
  });

  it("flushes only the interrupt-captured prompts, then holds the rest", async () => {
    const requested = await interruptContinuationRequested();
    expect(thread(requested).pendingTurnStart).toMatchObject({
      messageId: expect.stringMatching(/^continued:/),
    });
    expect(queuedIds(requested)).toEqual(["queued-c"]);
    // The session `ready` written while starting the continuation turn must not flush c.
    expect(queuedIds(ready)).toEqual(["queued-c"]);
    expect(thread(ready).session?.status).toBe("ready");
  });

  it("keeps queued-c until the continuation turn finishes, then delivers it once", async () => {
    const running = await applyWithLifecycleFlush(ready, sessionSet(ready, "running", "turn-ab"));
    expect(running.flushed).toBe(false);
    expect(thread(running.model).pendingTurnStart).toBeNull();
    // The reactor records the bound user turn after its running stamp.
    const bound = await applyWithLifecycleFlush(
      running.model,
      userTurnBound(continuationMessageId(ready), "turn-ab"),
    );
    expect(bound.flushed).toBe(false);
    expect(queuedIds(bound.model)).toEqual(["queued-c"]);

    const settled = await applyWithLifecycleFlush(bound.model, sessionSet(bound.model, "ready"));
    expect(settled.flushed).toBe(true);
    expect(queuedIds(settled.model)).toEqual([]);
    expect(thread(settled.model).pendingTurnStart).toMatchObject({ messageId: "queued-c" });
    const userMessages = thread(settled.model).messages.filter((m) => m.role === "user");
    expect(userMessages.map((m) => m.id)).toEqual([continuationMessageId(ready), "queued-c"]);
  });

  it("blocks a direct send behind the pending start by queueing it", async () => {
    const next = await apply(ready, {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("send-d"),
      threadId,
      message: {
        messageId: MessageId.makeUnsafe("direct-d"),
        role: "user",
        text: "D",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: now,
    });
    expect(queuedIds(next)).toEqual(["queued-c", "direct-d"]);
    expect(thread(next).pendingTurnStart?.messageId).toBe(continuationMessageId(ready));
  });
});

describe("pending-start exits never wedge the queue", () => {
  let ready: OrchestrationReadModel;

  beforeEach(async () => {
    ready = await continuationSessionReady();
  });

  it("clears and flushes when the turn start fails", async () => {
    const failed = await applyWithLifecycleFlush(ready, {
      type: "thread.turn.start.failed",
      commandId: CommandId.makeUnsafe("start-failed"),
      threadId,
      context: "provider-turn-start",
      detail: "Provider rejected the turn.",
      failureClass: "invalid-request",
      createdAt: now,
    });
    expect(failed.flushed).toBe(true);
    expect(queuedIds(failed.model)).toEqual([]);
  });

  it.each(["error", "stopped"] as const)(
    "clears and flushes when the session is %s",
    async (status) => {
      const ended = await applyWithLifecycleFlush(ready, sessionSet(ready, status));
      expect(ended.flushed).toBe(true);
      expect(queuedIds(ended.model)).toEqual([]);
    },
  );

  it("clears when the session errors while still starting", async () => {
    const starting = await continuationSessionStarting();
    const ended = await applyWithLifecycleFlush(starting, sessionSet(starting, "error"));
    expect(ended.flushed).toBe(true);
    expect(queuedIds(ended.model)).toEqual([]);
  });

  it("clears when the user stops the session, leaving the held queue to Send now", async () => {
    let model = await apply(ready, {
      type: "thread.session.stop",
      commandId: CommandId.makeUnsafe("stop"),
      threadId,
      createdAt: now,
    });
    expect(thread(model).pendingTurnStart).toBeNull();
    expect(thread(model).queueHold).toBe(true);
    model = (await applyWithLifecycleFlush(model, sessionSet(model, "stopped"))).model;
    expect(queuedIds(model)).toEqual(["queued-c"]);
    model = await apply(model, {
      type: "thread.queued-prompt.flush",
      commandId: CommandId.makeUnsafe("send-now"),
      threadId,
      messageIds: [MessageId.makeUnsafe("queued-c")],
      messageId: MessageId.makeUnsafe("send-now-message"),
      userRelease: true,
      createdAt: now,
    });
    expect(queuedIds(model)).toEqual([]);
  });

  it("clears when a busy provider refuses the turn and it is re-queued", async () => {
    const messageId = continuationMessageId(ready);
    const requeued = await apply(ready, {
      type: "thread.message.submit",
      commandId: CommandId.makeUnsafe("busy-requeue"),
      threadId,
      message: { messageId, text: "A\n\nB" },
      runtimeMode: "full-access",
      interactionMode: "default",
      redeliverSentMessage: true,
      delivery: "queue",
      createdAt: now,
    });
    expect(thread(requeued).pendingTurnStart).toBeNull();
    // Refused before queued-c was ever sent, so it is redelivered first.
    expect(queuedIds(requeued)).toEqual([messageId, "queued-c"]);

    // The provider's busy turn runs, then settles: the refused message goes alone, then c.
    const busy = await applyWithLifecycleFlush(requeued, sessionSet(requeued, "running", "busy"));
    expect(busy.flushed).toBe(false);
    const redelivered = await applyWithLifecycleFlush(busy.model, sessionSet(busy.model, "ready"));
    expect(redelivered.flushed).toBe(true);
    expect(thread(redelivered.model).pendingTurnStart?.messageId).toBe(messageId);
    expect(queuedIds(redelivered.model)).toEqual(["queued-c"]);
    const bound = await applyWithLifecycleFlush(
      redelivered.model,
      sessionSet(redelivered.model, "running", "turn-ab"),
    );
    const settled = await applyWithLifecycleFlush(bound.model, sessionSet(bound.model, "ready"));
    expect(thread(settled.model).pendingTurnStart?.messageId).toBe("queued-c");
    expect(queuedIds(settled.model)).toEqual([]);
  });

  it("lets Send now replace a start that has held the queue for two minutes of server time", async () => {
    // The client's clock runs an hour ahead; only server time may release the start.
    const clientCreatedAt = "2026-08-01T01:00:00.000Z";
    const sendNowAt = async (serverTime: string) => {
      vi.setSystemTime(serverTime);
      return apply(ready, {
        type: "thread.queued-prompt.flush",
        commandId: CommandId.makeUnsafe(`send-now-${serverTime}`),
        threadId,
        messageIds: [MessageId.makeUnsafe("queued-c")],
        messageId: MessageId.makeUnsafe("send-now-message"),
        userRelease: true,
        createdAt: clientCreatedAt,
      });
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(queuedIds(await sendNowAt("2026-08-01T00:01:59.000Z"))).toEqual(["queued-c"]);
      const released = await sendNowAt("2026-08-01T00:02:00.000Z");
      expect(queuedIds(released)).toEqual([]);
      expect(thread(released).pendingTurnStart?.messageId).toBe("queued-c");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the gate through archive, clears on the start's own exit, and flushes once restored", async () => {
    let model = await apply(ready, {
      type: "thread.archive",
      commandId: CommandId.makeUnsafe("archive"),
      threadId,
    });
    expect(thread(model).pendingTurnStart?.messageId).toBe(continuationMessageId(ready));
    const failed = await applyWithLifecycleFlush(model, {
      type: "thread.turn.start.failed",
      commandId: CommandId.makeUnsafe("archived-start-failed"),
      threadId,
      context: "provider-turn-start",
      detail: "Provider rejected the turn.",
      messageId: continuationMessageId(ready),
      createdAt: now,
    });
    expect(failed.flushed).toBe(false);
    expect(thread(failed.model).pendingTurnStart).toBeNull();
    model = await apply(failed.model, {
      type: "thread.unarchive",
      commandId: CommandId.makeUnsafe("unarchive"),
      threadId,
    });
    const restored = await applyWithLifecycleFlush(model, sessionSet(model, "ready"));
    expect(restored.flushed).toBe(true);
    expect(queuedIds(restored.model)).toEqual([]);
  });

  it("keeps the gate when an unrelated message's start fails", async () => {
    const failed = await applyWithLifecycleFlush(ready, {
      type: "thread.turn.start.failed",
      commandId: CommandId.makeUnsafe("other-start-failed"),
      threadId,
      context: "provider-turn-start",
      detail: "Another message failed.",
      messageId: MessageId.makeUnsafe("older-message"),
      createdAt: now,
    });
    expect(failed.flushed).toBe(false);
    expect(queuedIds(failed.model)).toEqual(["queued-c"]);
  });

  it("clears and flushes when the provider accepted and already finished the turn", async () => {
    // No running stamp: the provider was idle again before the reactor could stamp it.
    const bound = await applyWithLifecycleFlush(
      ready,
      userTurnBound(continuationMessageId(ready), "turn-ab"),
    );
    expect(bound.flushed).toBe(true);
    expect(queuedIds(bound.model)).toEqual([]);
  });

  it("ignores a bound activity for a different message", async () => {
    const other = await applyWithLifecycleFlush(
      ready,
      userTurnBound(MessageId.makeUnsafe("older-message"), "turn-old"),
    );
    expect(other.flushed).toBe(false);
    expect(queuedIds(other.model)).toEqual(["queued-c"]);
  });
});

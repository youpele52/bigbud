import { CommandId, MessageId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asTurnId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor queued prompt settlement", () => {
  registerProviderCommandReactorTestCleanup();

  it("settles an interrupt and flushes the queued prefix exactly once", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-send-now");
    const runtimeSession = await Effect.runPromise(
      harness.startSession(undefined, { threadId, runtimeMode: "approval-required" }),
    );
    (runtimeSession as { activeTurnId?: ReturnType<typeof asTurnId> }).activeTurnId = turnId;

    await seedRunningThread(harness, threadId, turnId, now, "send-now");
    await queuePrompt(harness, threadId, "message-send-now", "Send me", now, "send-now");
    await interruptAndFlush(harness, threadId, turnId, "message-send-now", now, "send-now");

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn).toHaveBeenCalledOnce();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    expect(readModel.threads[0]?.queuedPrompts).toEqual([]);
  });

  it("repairs a projected running turn when its provider session is missing", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-missing-runtime");

    await seedRunningThread(harness, threadId, turnId, now, "missing-runtime");
    await queuePrompt(
      harness,
      threadId,
      "message-missing-runtime",
      "Repair me",
      now,
      "missing-runtime",
    );
    await interruptAndFlush(
      harness,
      threadId,
      turnId,
      "message-missing-runtime",
      now,
      "missing-runtime",
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.sendTurn).toHaveBeenCalledOnce();
  });

  it("retains the queue when the provider rejects interruption", async () => {
    const harness = await createHarness({ interruptTurnFailure: "provider still owns the turn" });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-interrupt-failed");
    const runtimeSession = await Effect.runPromise(
      harness.startSession(undefined, { threadId, runtimeMode: "approval-required" }),
    );
    (runtimeSession as { activeTurnId?: ReturnType<typeof asTurnId> }).activeTurnId = turnId;

    await seedRunningThread(harness, threadId, turnId, now, "interrupt-failed");
    await queuePrompt(
      harness,
      threadId,
      "message-interrupt-failed",
      "Keep me",
      now,
      "interrupt-failed",
    );
    await interruptAndFlush(
      harness,
      threadId,
      turnId,
      "message-interrupt-failed",
      now,
      "interrupt-failed",
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    expect(readModel.threads[0]?.queuedPrompts?.map((prompt) => prompt.text)).toEqual(["Keep me"]);
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("does not flush while an interrupt is only acknowledged and the provider remains active", async () => {
    const harness = await createHarness({ interruptTurnLeavesSessionActive: true });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-delayed-settlement");
    const runtimeSession = await Effect.runPromise(
      harness.startSession(undefined, { threadId, runtimeMode: "approval-required" }),
    );
    (runtimeSession as { activeTurnId?: ReturnType<typeof asTurnId> }).activeTurnId = turnId;

    await seedRunningThread(harness, threadId, turnId, now, "delayed-settlement");
    await queuePrompt(
      harness,
      threadId,
      "message-delayed-settlement",
      "Wait for provider",
      now,
      "delayed-settlement",
    );
    await interruptAndFlush(
      harness,
      threadId,
      turnId,
      "message-delayed-settlement",
      now,
      "delayed-settlement",
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.interruptTurn).toHaveBeenCalledOnce();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });
});

async function seedRunningThread(
  harness: Awaited<ReturnType<typeof createHarness>>,
  threadId: ThreadId,
  turnId: ReturnType<typeof asTurnId>,
  createdAt: string,
  suffix: string,
) {
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(`cmd-session-set-${suffix}`),
      threadId,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: turnId,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    }),
  );
}

async function queuePrompt(
  harness: Awaited<ReturnType<typeof createHarness>>,
  threadId: ThreadId,
  messageId: string,
  text: string,
  createdAt: string,
  suffix: string,
) {
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.message.submit",
      commandId: CommandId.makeUnsafe(`cmd-queue-${suffix}`),
      threadId,
      message: { messageId: MessageId.makeUnsafe(messageId), text },
      delivery: "queue",
      createdAt,
    }),
  );
}

async function interruptAndFlush(
  harness: Awaited<ReturnType<typeof createHarness>>,
  threadId: ThreadId,
  turnId: ReturnType<typeof asTurnId>,
  messageId: string,
  createdAt: string,
  suffix: string,
) {
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.makeUnsafe(`cmd-interrupt-${suffix}`),
      threadId,
      turnId,
      queuedPromptIdsAfterSettlement: [MessageId.makeUnsafe(messageId)],
      createdAt,
    }),
  );
}

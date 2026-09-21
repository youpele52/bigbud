import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId, TurnId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { canAutoDispatchQueuedPrompts } from "../QueuedPromptPolicy.logic.ts";
import {
  asMessageId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor blocking send admission", () => {
  registerProviderCommandReactorTestCleanup();

  it("auto-dispatches a follow-up after a blocking send that already settled idle", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "cursor",
        model: "grok-4.6",
      },
    });
    let sendCount = 0;
    harness.sendTurn.mockImplementation(() => {
      sendCount += 1;
      return Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe(`turn-blocking-${sendCount}`),
      });
    });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.submit",
        commandId: CommandId.makeUnsafe("cmd-blocking-first"),
        threadId,
        message: {
          messageId: asMessageId("user-message-blocking-1"),
          text: "first cursor message",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        delivery: "auto",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const afterFirst = await Effect.runPromise(harness.engine.getReadModel());
    const firstThread = afterFirst.threads.find((thread) => thread.id === threadId);
    expect(firstThread?.session?.status).not.toBe("running");
    expect(firstThread?.session?.activeTurnId ?? null).toBeNull();
    expect(firstThread ? canAutoDispatchQueuedPrompts(firstThread) : false).toBe(true);
    expect(firstThread?.queuedPrompts ?? []).toEqual([]);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.submit",
        commandId: CommandId.makeUnsafe("cmd-blocking-follow-up"),
        threadId,
        message: {
          messageId: asMessageId("user-message-blocking-2"),
          text: "second cursor message",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        delivery: "auto",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    const afterSecond = await Effect.runPromise(harness.engine.getReadModel());
    const secondThread = afterSecond.threads.find((thread) => thread.id === threadId);
    expect(secondThread?.queuedPrompts ?? []).toEqual([]);
    expect(harness.sendTurn.mock.calls.length).toBe(2);
  });
});

import { CommandId, MessageId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asEventId,
  asThreadId,
  asTurnId,
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "./ProviderRuntimeIngestion.test.helpers.ts";

describe("ProviderRuntimeIngestion queued prompt settlement", () => {
  registerProviderRuntimeIngestionTestCleanup();

  it.each([
    ["completed", "ready"],
    ["failed", "error"],
    ["interrupted", "ready"],
  ] as const)("flushes a queued follow-up after %s settlement", async (status, sessionStatus) => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId(`turn-settlement-${status}`);
    const createdAt = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId(`event-started-${status}`),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt,
    });
    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "running" && thread.session.activeTurnId === turnId,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.submit",
        commandId: CommandId.makeUnsafe(`command-queue-${status}`),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe(`message-queue-${status}`),
          text: `Follow up after ${status}`,
        },
        delivery: "auto",
        createdAt,
      }),
    );
    expect(
      (await Effect.runPromise(harness.engine.getReadModel())).threads[0]?.queuedPrompts,
    ).toHaveLength(1);

    harness.emit({
      type: "turn.completed",
      eventId: asEventId(`event-completed-${status}`),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId,
      status,
      ...(status === "failed" ? { errorMessage: "provider failed" } : {}),
      createdAt: new Date().toISOString(),
    });

    const settled = await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === sessionStatus &&
        (thread.queuedPrompts?.length ?? 0) === 0 &&
        thread.messages.some((message) => message.text.includes(`Follow up after ${status}`)),
    );
    expect(settled.queuedPrompts).toEqual([]);
  });
});

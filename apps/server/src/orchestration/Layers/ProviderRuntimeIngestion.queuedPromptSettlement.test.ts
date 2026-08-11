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

  it("reconciles a rejected terminal event from the live idle session and flushes once", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const projectedTurnId = asTurnId("turn-projected");
    const createdAt = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("event-started-rejected-terminal"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId: projectedTurnId,
      createdAt,
    });
    await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === projectedTurnId,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.submit",
        commandId: CommandId.makeUnsafe("command-queue-rejected-terminal"),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe("message-queue-rejected-terminal"),
          text: "Continue after reconciliation",
        },
        delivery: "queue",
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: "opencode",
      status: "ready",
      runtimeMode: "approval-required",
      threadId,
      createdAt,
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("event-completed-mismatched-terminal"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-mismatched"),
      status: "completed",
      createdAt,
    });

    const settled = await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        (thread.queuedPrompts?.length ?? 0) === 0 &&
        thread.messages.filter((message) => message.text.includes("Continue after reconciliation"))
          .length === 1,
    );
    expect(settled.queuedPrompts).toEqual([]);
  });

  it("preserves a newer live turn when an older provider terminal event arrives", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const projectedTurnId = asTurnId("turn-old");
    const liveTurnId = asTurnId("turn-new");
    const createdAt = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("event-started-old-turn"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId: projectedTurnId,
      createdAt,
    });
    await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === projectedTurnId,
    );
    harness.setProviderSession({
      provider: "opencode",
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: liveTurnId,
      createdAt,
      updatedAt: createdAt,
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("event-completed-old-turn"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId: projectedTurnId,
      status: "completed",
      createdAt,
    });

    const preserved = await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === liveTurnId,
    );
    expect(preserved.session?.status).toBe("running");
    expect(preserved.session?.providerName).toBe("opencode");
  });

  it("rejects stale provider exit and error events while a newer live turn is active", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const projectedTurnId = asTurnId("turn-stale-provider");
    const liveTurnId = asTurnId("turn-current-provider");
    const createdAt = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("event-started-stale-provider"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId: projectedTurnId,
      createdAt,
    });
    await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === projectedTurnId,
    );
    harness.setProviderSession({
      provider: "opencode",
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: liveTurnId,
      createdAt,
      updatedAt: createdAt,
    });
    harness.emit({
      type: "session.exited",
      eventId: asEventId("event-exited-stale-provider"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt,
    });
    harness.emit({
      type: "runtime.error",
      eventId: asEventId("event-error-stale-provider"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId: projectedTurnId,
      payload: { message: "stale disconnect", class: "transport_error" },
      createdAt,
    });

    const preserved = await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === liveTurnId,
    );
    expect(preserved.session?.status).toBe("running");
    expect(preserved.session?.providerName).toBe("opencode");
  });
});

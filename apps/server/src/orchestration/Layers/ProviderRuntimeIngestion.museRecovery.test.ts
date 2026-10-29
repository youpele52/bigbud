import { describe, expect, it } from "vitest";

import {
  asEventId,
  asItemId,
  asThreadId,
  asTurnId,
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "./ProviderRuntimeIngestion.test.helpers.ts";

const now = "2026-10-29T00:00:00.000Z";

function started(eventId: string, turnId: string) {
  return {
    type: "turn.started" as const,
    eventId: asEventId(eventId),
    provider: "muse" as const,
    createdAt: now,
    threadId: asThreadId("thread-1"),
    turnId: asTurnId(turnId),
    payload: {},
  };
}

function assistantItem(eventId: string, turnId: string, itemId: string, text: string) {
  return {
    type: "item.completed" as const,
    eventId: asEventId(eventId),
    provider: "muse" as const,
    createdAt: now,
    threadId: asThreadId("thread-1"),
    turnId: asTurnId(turnId),
    itemId: asItemId(itemId),
    payload: { itemType: "assistant_message" as const, status: "completed" as const, detail: text },
  };
}

function completed(eventId: string, turnId: string, state: string, recovery = false) {
  return {
    type: "turn.completed" as const,
    eventId: asEventId(eventId),
    provider: "muse" as const,
    createdAt: now,
    threadId: asThreadId("thread-1"),
    turnId: asTurnId(turnId),
    payload: { state, ...(recovery ? { recoveryRedelivery: true } : {}) },
  };
}

describe("Muse recovery terminal delivery (Phase 3.15 crash windows)", () => {
  registerProviderRuntimeIngestionTestCleanup();

  it("delivers a missing canonical outcome when the first delivery crashed after claim/publication", async () => {
    const harness = await createHarness({ provider: "muse" });
    // Native settled and text streamed, but the original turn.completed
    // never reached canonical ingestion (crash after liveness claim or
    // after stream publication, before canonical application).
    harness.emit(started("evt-started-1", "turn-1"));
    harness.emit(assistantItem("evt-item-1", "turn-1", "item-1", "recovered answer"));
    harness.emit(completed("muse-recovery-terminal-turn-1", "turn-1", "completed", true));

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some((message) => message.id === "assistant:item-1" && !message.streaming),
    );
    expect(thread.messages.find((message) => message.id === "assistant:item-1")?.text).toBe(
      "recovered answer",
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.activeTurnId).toBeNull();
  });

  it("is idempotent after canonical application: repeated recovery does not duplicate the outcome", async () => {
    const harness = await createHarness({ provider: "muse" });
    harness.emit(started("evt-started-1", "turn-1"));
    harness.emit(assistantItem("evt-item-1", "turn-1", "item-1", "final answer"));
    harness.emit(completed("evt-completed-1", "turn-1", "completed"));
    const applied = await waitForThread(harness.engine, (entry) =>
      entry.messages.some((message) => message.id === "assistant:item-1" && !message.streaming),
    );
    const messageCount = applied.messages.length;

    // Crash after canonical application but before recovery acknowledgement:
    // the same recovery redelivery must not apply a second outcome.
    harness.emit(completed("muse-recovery-terminal-turn-1", "turn-1", "completed", true));
    harness.emit(completed("muse-recovery-terminal-turn-1", "turn-1", "completed", true));
    await harness.drain();

    const thread = await waitForThread(harness.engine, (entry) => entry.id === "thread-1");
    expect(thread.messages).toHaveLength(messageCount);
    expect(thread.messages.filter((message) => message.id === "assistant:item-1")).toHaveLength(1);
    expect(thread.session?.status).toBe("ready");
  });

  it("settles a failed-before-start turn from recovery evidence without a prior start", async () => {
    const harness = await createHarness({ provider: "muse" });
    // Native failed completion without turn.started: no canonical turn was
    // ever started, and the pending outcome must still settle visibly.
    harness.emit(completed("muse-recovery-terminal-turn-9", "turn-9", "failed", true));
    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "error",
    );
    expect(thread.session?.activeTurnId).toBeNull();
  });

  it("settles a reclaimed-queued interruption from recovery evidence", async () => {
    const harness = await createHarness({ provider: "muse" });
    harness.emit(started("evt-started-1", "turn-1"));
    harness.emit(completed("muse-recovery-terminal-turn-1", "turn-1", "interrupted", true));
    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "ready" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("ready");
  });
});

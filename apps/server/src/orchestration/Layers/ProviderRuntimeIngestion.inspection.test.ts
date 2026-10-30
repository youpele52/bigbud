import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { RuntimeItemId } from "@bigbud/contracts";
import {
  asEventId,
  asItemId,
  asThreadId,
  asTurnId,
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "./ProviderRuntimeIngestion.test.helpers.ts";

describe("inspection final-item reconciliation", () => {
  registerProviderRuntimeIngestionTestCleanup();

  it("replaces partial text at the original item ID exactly once before terminal settlement", async () => {
    const h = await createHarness();
    const base = {
      provider: "codex" as const,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("reconciled"),
      createdAt: "2026-10-30T10:00:00.000Z",
    };
    h.emit({ ...base, eventId: asEventId("start"), type: "turn.started" });
    await waitForThread(h.engine, (thread) => thread.session?.activeTurnId === "reconciled");
    h.emit({
      ...base,
      eventId: asEventId("partial"),
      type: "content.delta",
      itemId: asItemId("original"),
      payload: { streamKind: "assistant_text", delta: "partial" },
    });
    await h.drain();
    const final: ProviderRuntimeEvent = {
      ...base,
      sessionEpoch: 0,
      eventId: asEventId("final-exact"),
      type: "item.completed",
      itemId: RuntimeItemId.makeUnsafe("original"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "full durable output",
        data: { item: { id: "original", type: "agentMessage", text: "full durable output" } },
      },
    };
    expect(await Effect.runPromise(h.reconcileInspection([final]))).toBe(true);
    expect(await Effect.runPromise(h.reconcileInspection([final]))).toBe(true);
    const thread = (await Effect.runPromise(h.engine.getReadModel())).threads[0]!;
    expect(thread.messages.filter((message) => message.id === "assistant:original")).toHaveLength(
      1,
    );
    expect(thread.messages.find((message) => message.id === "assistant:original")?.text).toBe(
      "full durable output",
    );
    expect(thread.session?.activeTurnId).toBe("reconciled");
    expect(thread.messages.find((message) => message.id === "assistant:original")?.streaming).toBe(
      false,
    );
  });

  it("rejects stale epoch and child-turn batches before they mutate messages", async () => {
    const h = await createHarness();
    const base = {
      provider: "codex" as const,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("parent"),
      createdAt: new Date().toISOString(),
    };
    h.emit({ ...base, eventId: asEventId("parent-start"), type: "turn.started" });
    await waitForThread(h.engine, (thread) => thread.session?.activeTurnId === "parent");
    const event: ProviderRuntimeEvent = {
      ...base,
      sessionEpoch: 4,
      eventId: asEventId("stale-final"),
      type: "item.completed",
      itemId: RuntimeItemId.makeUnsafe("stale"),
      payload: { itemType: "assistant_message", detail: "must not appear" },
    };
    expect(await Effect.runPromise(h.reconcileInspection([event]))).toBe(false);
    expect(
      await Effect.runPromise(
        h.reconcileInspection([{ ...event, sessionEpoch: 0, turnId: asTurnId("child") }]),
      ),
    ).toBe(false);
    expect((await Effect.runPromise(h.engine.getReadModel())).threads[0]?.messages).toHaveLength(0);
  });
});

import {
  CommandId,
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts/core/baseSchemas";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  useThinkingHarness,
  waitForThread,
} from "./ProviderRuntimeIngestion.thinking.test.helpers.ts";

describe("V2 authoritative reasoning recovery", () => {
  const createHarness = useThinkingHarness();
  it("persists complete reasoning without requiring a delivered stream delta", async () => {
    const harness = await createHarness();
    const event = {
      type: "item.completed",
      eventId: EventId.makeUnsafe("v2-reasoning-repair"),
      provider: "opencodeV2",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("v2-reasoning-turn"),
      itemId: RuntimeItemId.makeUnsafe("v2-reasoning-item"),
      createdAt: new Date().toISOString(),
      payload: { itemType: "reasoning", status: "completed", detail: "authoritative reasoning" },
    } as const;
    harness.emit(event);
    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "thinking.stream"),
    );
    const activity = thread.activities.find((activity) => activity.kind === "thinking.stream");
    expect(activity?.payload).toMatchObject({
      detail: "authoritative reasoning",
      streamKind: "reasoning_text",
      fullCharCount: 23,
    });
  });
  it("replaces partial reasoning, deduplicates full repairs, and ignores stale epochs", async () => {
    const harness = await createHarness();
    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0]!;
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("v2-thinking-epoch"),
        threadId: thread.id,
        session: { ...thread.session!, sessionEpoch: 2 },
        advanceSessionEpoch: true,
        createdAt,
      }),
    );
    const base = {
      provider: "opencodeV2",
      threadId: thread.id,
      turnId: TurnId.makeUnsafe("repair-turn"),
      itemId: RuntimeItemId.makeUnsafe("repair-item"),
      createdAt,
      sessionEpoch: 1,
    } as const;
    harness.emit({
      ...base,
      type: "content.delta",
      eventId: EventId.makeUnsafe("partial-reasoning"),
      payload: { streamKind: "reasoning_text", delta: "partial" },
    });
    const final = {
      ...base,
      type: "item.completed",
      eventId: EventId.makeUnsafe("full-reasoning"),
      payload: {
        itemType: "reasoning",
        status: "completed",
        detail: "authoritative full reasoning",
      },
    } as const;
    harness.emit(final);
    harness.emit(final);
    harness.emit({ ...final, eventId: EventId.makeUnsafe("duplicate-full-reasoning") });
    harness.emit({
      ...final,
      sessionEpoch: 0,
      eventId: EventId.makeUnsafe("stale-reasoning"),
      payload: { ...final.payload, detail: "stale corrupted reasoning" },
    });
    // A same-stream valid barrier proves the stale event and duplicates were processed first.
    harness.emit({
      ...final,
      itemId: RuntimeItemId.makeUnsafe("barrier"),
      eventId: EventId.makeUnsafe("reasoning-barrier"),
      payload: { ...final.payload, detail: "valid barrier" },
    });
    const current = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity) =>
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "valid barrier",
      ),
    );
    const activities = current.activities.filter(
      (activity) => activity.kind === "thinking.stream" && activity.id.includes("repair-item"),
    );
    expect(activities).toHaveLength(1);
    expect(activities[0]?.payload).toMatchObject({
      detail: "authoritative full reasoning",
      fullCharCount: 28,
      truncated: false,
    });
  });
});

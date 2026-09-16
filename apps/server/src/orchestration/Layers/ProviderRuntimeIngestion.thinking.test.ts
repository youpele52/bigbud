import { EventId, RuntimeItemId, RuntimeTaskId, ThreadId, TurnId } from "@bigbud/contracts";
import type { OrchestrationReadModel } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";
import {
  THINKING_ACTIVITY_HEAD_CHARS,
  THINKING_ACTIVITY_TAIL_CHARS,
  THINKING_ACTIVITY_TRUNCATION_MARKER,
} from "../thinkingActivity.ts";
import {
  useThinkingHarness,
  waitForThread,
} from "./ProviderRuntimeIngestion.thinking.test.helpers.ts";
const asItemId = (value: string) => RuntimeItemId.makeUnsafe(value);
const asEventId = (value: string) => EventId.makeUnsafe(value);
const asThreadId = (value: string) => ThreadId.makeUnsafe(value);
const asTurnId = (value: string) => TurnId.makeUnsafe(value);
type TestActivity = OrchestrationReadModel["threads"][number]["activities"][number];

describe("ProviderRuntimeIngestion thinking", () => {
  const createHarness = useThinkingHarness();
  it("persists a coalesced thinking activity when reasoning deltas complete", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-thinking-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-thinking-1"),
      itemId: asItemId("item-thinking-1"),
      payload: {
        streamKind: "reasoning_text",
        delta: "thinking",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-thinking-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-thinking-1"),
      itemId: asItemId("item-thinking-1"),
      payload: {
        streamKind: "reasoning_text",
        delta: " harder",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-thinking-item-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-thinking-1"),
      itemId: asItemId("item-thinking-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: TestActivity) =>
          activity.id ===
          "thinking:thread-1:turn:turn-thinking-1:item:item-thinking-1:reasoning_text",
      ),
    );
    const activity = thread.activities.find(
      (entry: TestActivity) =>
        entry.id === "thinking:thread-1:turn:turn-thinking-1:item:item-thinking-1:reasoning_text",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.tone).toBe("thinking");
    expect(activity?.kind).toBe("thinking.stream");
    expect(activity?.summary).toBe("Thinking");
    expect(payload?.detail).toBe("thinking harder");
    expect(payload?.streamKind).toBe("reasoning_text");
    expect(payload?.fullCharCount).toBe("thinking harder".length);
    expect(payload?.persistedCharCount).toBe("thinking harder".length);
    expect(payload?.truncated).toBe(false);
  });

  it("truncates persisted thinking activities to head plus tail on turn completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const head = "a".repeat(THINKING_ACTIVITY_HEAD_CHARS);
    const middle = "b".repeat(37);
    const tail = "c".repeat(THINKING_ACTIVITY_TAIL_CHARS);
    const fullText = `${head}${middle}${tail}`;
    const persistedText = `${head}${THINKING_ACTIVITY_TRUNCATION_MARKER}${tail}`;

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-thinking-large-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-thinking-2"),
      itemId: asItemId("item-thinking-2"),
      payload: {
        streamKind: "reasoning_text",
        delta: fullText,
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-thinking-turn-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-thinking-2"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: TestActivity) =>
          activity.id ===
          "thinking:thread-1:turn:turn-thinking-2:item:item-thinking-2:reasoning_text",
      ),
    );
    const activity = thread.activities.find(
      (entry: TestActivity) =>
        entry.id === "thinking:thread-1:turn:turn-thinking-2:item:item-thinking-2:reasoning_text",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(payload?.detail).toBe(persistedText);
    expect(payload?.fullCharCount).toBe(fullText.length);
    expect(payload?.persistedCharCount).toBe(persistedText.length);
    expect(payload?.truncated).toBe(true);
  });

  it("does not persist finalized thinking activities when thinking streaming is disabled", async () => {
    const harness = await createHarness({ enableThinkingStreaming: false });
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-thinking-disabled-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-thinking-disabled"),
      itemId: asItemId("item-thinking-disabled"),
      payload: {
        streamKind: "reasoning_text",
        delta: "thinking that should stay hidden",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-thinking-disabled-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-thinking-disabled"),
      itemId: asItemId("item-thinking-disabled"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-thinking-disabled-warning"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        message: "flush hidden thinking path",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: TestActivity) => activity.id === "evt-thinking-disabled-warning",
      ),
    );

    expect(
      thread.activities.some(
        (activity: TestActivity) =>
          activity.id ===
          "thinking:thread-1:turn:turn-thinking-disabled:item:item-thinking-disabled:reasoning_text",
      ),
    ).toBe(false);
  });

  it("does not project reasoning-style task progress when thinking streaming is disabled", async () => {
    const harness = await createHarness({ enableThinkingStreaming: false });
    const now = new Date().toISOString();

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-thinking-disabled-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-thinking-disabled-task-progress"),
      payload: {
        taskId: RuntimeTaskId.makeUnsafe("task-thinking-disabled"),
        description: "This should not be shown as provider thinking.",
      },
    });
    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-thinking-disabled-task-warning"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        message: "flush hidden task progress path",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: TestActivity) => activity.id === "evt-thinking-disabled-task-warning",
      ),
    );

    expect(
      thread.activities.some(
        (activity: TestActivity) => activity.id === "evt-thinking-disabled-task-progress",
      ),
    ).toBe(false);
  });
});

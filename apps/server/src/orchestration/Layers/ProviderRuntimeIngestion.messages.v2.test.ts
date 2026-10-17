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

describe("V2 authoritative final text canonical seam", () => {
  registerProviderRuntimeIngestionTestCleanup();
  it.each([true, false])(
    "repairs missing deltas without appending duplicate finals (streaming=%s)",
    async (streaming) => {
      const harness = await createHarness({
        provider: "opencodeV2",
        serverSettings: { enableAssistantStreaming: streaming },
      });
      const stamp = {
        provider: "opencodeV2" as const,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("v2-turn"),
        createdAt: new Date().toISOString(),
      };
      const itemId = asItemId("v2-assistant");
      harness.emit({ ...stamp, type: "turn.started", eventId: asEventId("v2-start") });
      await waitForThread(
        harness.engine,
        (thread) => thread.session?.activeTurnId === stamp.turnId,
      );
      harness.emit({
        ...stamp,
        type: "content.delta",
        eventId: asEventId("v2-partial"),
        itemId,
        payload: { streamKind: "assistant_text", delta: "first\nlast\n" },
      });
      if (streaming)
        await waitForThread(harness.engine, (thread) =>
          thread.messages.some((message) => message.streaming),
        );
      const fullText = "first\nmissing middle\nlast\n";
      const final = {
        ...stamp,
        type: "item.completed" as const,
        itemId,
        payload: {
          itemType: "assistant_message" as const,
          status: "completed" as const,
          detail: fullText,
        },
      };
      harness.emit({ ...final, eventId: asEventId("v2-final-live") });
      await waitForThread(harness.engine, (thread) =>
        thread.messages.some((message) => message.text === fullText && !message.streaming),
      );
      harness.emit({ ...final, eventId: asEventId("v2-final-reconciliation") });
      await harness.drain();
      const thread = await waitForThread(harness.engine, (entry) =>
        entry.messages.some((message) => message.id === "assistant:v2-assistant"),
      );
      const assistant = thread.messages.filter((message) => message.role === "assistant");
      expect(assistant).toHaveLength(1);
      expect(assistant[0]?.text).toBe(fullText);
      expect(assistant[0]?.streaming).toBe(false);
    },
  );
});

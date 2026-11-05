import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it } from "vitest";

import { mapMuseNotification } from "./Adapter.stream.ts";
import { trackMuseItem } from "./Adapter.stream.items.ts";
import type { MuseLiveItem } from "./Adapter.types.ts";
import type { MuseNotification } from "./Client.ts";

const threadId = ThreadId.makeUnsafe("thread-muse-stream");
const turnId = "01a18788-806d-7000-8fed-4aeb3cc8233d";

/** Feeds notifications through the mapper exactly as the host callbacks do. */
function run(notifications: ReadonlyArray<MuseNotification>) {
  const items = new Map<string, MuseLiveItem>();
  const events = notifications.flatMap((notification) => {
    const mapped = mapMuseNotification(threadId, notification, items);
    trackMuseItem(items, notification);
    return mapped;
  });
  return { events, items };
}

const started = (itemId: string, kind: string, extra: Record<string, unknown> = {}) => ({
  method: "item/started",
  params: { item: { itemId, kind, turnId, status: "inProgress", ...extra } },
});
const completed = (itemId: string, kind: string, extra: Record<string, unknown> = {}) => ({
  method: "item/completed",
  params: { item: { itemId, kind, turnId, status: "completed", ...extra } },
});
// Native deltas name only the item and the field, never the turn.
const delta = (itemId: string, field: string, text: string) => ({
  method: "item/delta",
  params: { itemId, field, delta: text },
});

describe("Muse item stream mapping", () => {
  it("routes agent text deltas to assistant text with the owning turn", () => {
    const { events } = run([
      started("agent-1", "agentMessage"),
      delta("agent-1", "text", "91 = 7 × 13"),
      completed("agent-1", "agentMessage", { text: "91 = 7 × 13", messagePhase: "finalAnswer" }),
    ]);
    const deltaEvent = events.find((event) => event.type === "content.delta");
    expect(deltaEvent).toMatchObject({
      turnId,
      itemId: "agent-1",
      payload: { streamKind: "assistant_text", delta: "91 = 7 × 13" },
    });
    expect(events.at(-1)).toMatchObject({
      type: "item.completed",
      payload: { itemType: "assistant_message", detail: "91 = 7 × 13" },
    });
  });

  it("routes reasoning summary deltas to the thinking summary stream, never assistant text", () => {
    const { events } = run([
      started("reason-1", "reasoning", { summary: [] }),
      delta("reason-1", "summary.0", "Balancing steps"),
      completed("reason-1", "reasoning", { summary: ["Balancing steps"] }),
    ]);
    expect(events.filter((event) => event.type === "content.delta")).toEqual([
      expect.objectContaining({
        turnId,
        payload: {
          streamKind: "reasoning_summary_text",
          summaryIndex: 0,
          delta: "Balancing steps",
        },
      }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "item.completed",
      payload: { itemType: "reasoning", detail: "Balancing steps" },
    });
  });

  it("drops deltas of non user-facing items such as reminder children", () => {
    const { events } = run([
      started("reminder-1", "reminderChild"),
      delta("reminder-1", "text", "internal reminder decision"),
    ]);
    expect(events.some((event) => event.type === "content.delta")).toBe(false);
  });

  it("forgets live items when they complete or their turn settles", () => {
    const { items } = run([
      started("agent-1", "agentMessage"),
      started("reminder-1", "reminderChild"),
      completed("agent-1", "agentMessage", { text: "done" }),
    ]);
    expect([...items.keys()]).toEqual(["reminder-1"]);
    trackMuseItem(items, { method: "turn/completed", params: { turnId, terminal: "completed" } });
    expect(items.size).toBe(0);
  });
});

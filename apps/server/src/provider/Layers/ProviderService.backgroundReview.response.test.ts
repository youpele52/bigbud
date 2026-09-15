import { EventId, RuntimeItemId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import { describe, expect, it } from "vitest";
import { makeBackgroundReviewResponse } from "./ProviderService.backgroundReview.response.ts";

let sequence = 0;
const base = (itemId?: string) => ({
  eventId: EventId.makeUnsafe(`response-event-${++sequence}`),
  provider: "codex" as const,
  threadId: ThreadId.makeUnsafe("background-review-response"),
  createdAt: "2026-09-15T00:00:00.000Z",
  ...(itemId === undefined ? {} : { itemId: RuntimeItemId.makeUnsafe(itemId) }),
});
const delta = (text: string, itemId?: string): ProviderRuntimeEvent => ({
  ...base(itemId),
  type: "content.delta",
  payload: { streamKind: "assistant_text", delta: text },
});
const completed = (detail?: string, itemId?: string): ProviderRuntimeEvent => ({
  ...base(itemId),
  type: "item.completed",
  payload: { itemType: "assistant_message", ...(detail === undefined ? {} : { detail }) },
});

describe("background review canonical response", () => {
  it("assembles delta-only responses and preserves legitimate identical deltas", () => {
    const response = makeBackgroundReviewResponse(24_000);
    response.append(delta("ha", "a"));
    response.append(delta("ha", "a"));
    expect(response.text()).toBe("haha");
  });

  it("replaces only the completed item, preserving other items and first appearance order", () => {
    const response = makeBackgroundReviewResponse(24_000);
    response.append(delta("first partial", "a"));
    response.append(delta("second", "b"));
    response.append(completed("first", "a"));
    response.append(completed(undefined, "b"));
    response.append(delta("third", "c"));
    response.append(completed("fourth", "d"));
    expect(response.text()).toBe("firstsecondthirdfourth");
  });

  it("supports snapshot-only items without duplicating repeated completions", () => {
    const response = makeBackgroundReviewResponse(24_000);
    response.append(completed("first", "a"));
    response.append(completed("second", "b"));
    response.append(completed("first", "a"));
    response.append(completed("FIRST", "a"));
    expect(response.text()).toBe("FIRSTsecond");
  });

  it("ignores late deltas after an authoritative snapshot", () => {
    const response = makeBackgroundReviewResponse(24_000);
    response.append(delta("partial", "a"));
    response.append(completed("final", "a"));
    response.append(delta("late", "a"));
    response.append(completed(undefined, "a"));
    response.append(delta("later", "a"));
    expect(response.text()).toBe("final");
  });

  it("does not create phantom text or reserve positions for no-detail completions", () => {
    const response = makeBackgroundReviewResponse(24_000);
    response.append(completed(undefined, "a"));
    response.append(completed(undefined));
    response.append(completed("", "empty"));
    response.append(completed("   ", "blank"));
    response.append(delta("first", "b"));
    response.append(delta("second", "a"));
    response.append(completed(undefined, "a"));
    response.append(completed("", "a"));
    expect(response.text()).toBe("firstsecond");
  });

  it("uses a separate shared slot for unkeyed deltas and snapshots", () => {
    const response = makeBackgroundReviewResponse(24_000);
    response.append(delta("par"));
    response.append(delta("tial"));
    response.append(delta("keyed", "a"));
    response.append(completed("final"));
    response.append(completed("final"));
    expect(response.text()).toBe("finalkeyed");
  });

  it("deduplicates replayed delta and snapshot event IDs", () => {
    const response = makeBackgroundReviewResponse(24_000);
    const chunk = delta("partial", "a");
    const snapshot = completed("first", "a");
    response.append(chunk);
    response.append(chunk);
    expect(response.text()).toBe("partial");
    response.append(snapshot);
    response.append(completed("latest", "a"));
    response.append(snapshot);
    expect(response.text()).toBe("latest");
  });

  it("ignores reasoning and tool output", () => {
    const response = makeBackgroundReviewResponse(24_000);
    response.append({
      ...base("reasoning"),
      type: "content.delta",
      payload: { streamKind: "reasoning_text", delta: "private reasoning" },
    });
    response.append({
      ...base("tool"),
      type: "item.completed",
      payload: { itemType: "command_execution", detail: "tool output" },
    });
    response.append(completed("answer", "a"));
    expect(response.text()).toBe("answer");
  });

  it("rejects oversized deltas without mutating the accepted response", () => {
    const response = makeBackgroundReviewResponse(5);
    expect(response.append(delta("12345", "a"))).toBe(true);
    expect(response.append(delta("6", "a"))).toBe(false);
    expect(response.append(delta("6", "b"))).toBe(false);
    expect(response.text()).toBe("12345");
  });

  it("checks snapshot replacement size against the entire response", () => {
    const response = makeBackgroundReviewResponse(5);
    response.append(delta("123", "a"));
    response.append(delta("45", "b"));
    expect(response.append(completed("abc", "a"))).toBe(true);
    expect(response.append(completed("abcd", "a"))).toBe(false);
    expect(response.text()).toBe("abc45");
    expect(response.append(completed("a", "a"))).toBe(true);
    expect(response.append(delta("67", "b"))).toBe(true);
    expect(response.text()).toBe("a4567");
  });

  it("rejects oversized snapshot-only output", () => {
    const response = makeBackgroundReviewResponse(5);
    expect(response.append(completed("123456", "a"))).toBe(false);
    expect(response.text()).toBe("");
  });
});

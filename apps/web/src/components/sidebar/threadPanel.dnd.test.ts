import { describe, expect, it } from "vitest";

import {
  BIGBUD_THREAD_CONTEXT_DRAG_MIME,
  parseThreadContextDragPayload,
  serializeThreadContextDragPayload,
} from "./threadPanel.dnd";

describe("threadPanel.dnd", () => {
  it("serializes and parses a thread context payload", () => {
    const payload = {
      threadId: "thread-abc" as import("@bigbud/contracts").ThreadId,
      title: "Foo",
    };
    const serialized = serializeThreadContextDragPayload(payload);
    expect(parseThreadContextDragPayload(serialized)).toEqual(payload);
  });

  it("returns null for invalid payloads", () => {
    expect(parseThreadContextDragPayload("")).toBeNull();
    expect(parseThreadContextDragPayload("not-json")).toBeNull();
    expect(parseThreadContextDragPayload(JSON.stringify({ threadId: "", title: "" }))).toBeNull();
    expect(parseThreadContextDragPayload(JSON.stringify({ threadId: "x" }))).toBeNull();
    expect(parseThreadContextDragPayload(JSON.stringify({ title: "x" }))).toBeNull();
  });

  it("exposes a stable MIME type", () => {
    expect(BIGBUD_THREAD_CONTEXT_DRAG_MIME).toBe("application/x-bigbud-thread-context");
  });
});

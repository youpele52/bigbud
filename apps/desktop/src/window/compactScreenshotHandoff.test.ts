import { describe, expect, it } from "vitest";

import { CompactScreenshotHandoff } from "./compactScreenshotHandoff";

const image = {
  id: "capture-1",
  name: "screen.jpg",
  mimeType: "image/jpeg" as const,
  sizeBytes: 4,
  dataUrl: "data:image/jpeg;base64,anBlZw==",
};

describe("compact screenshot handoff", () => {
  it("retains a cold-start capture until a restored or new chat claims it", () => {
    const handoff = new CompactScreenshotHandoff();
    handoff.put({ ...image, threadId: null });
    expect(handoff.pending).toBe(true);
    expect(handoff.read("new-chat")).toEqual({ ...image, threadId: "new-chat" });
    expect(handoff.pending).toBe(true);
  });

  it("pins the most recently used floating thread at capture time", () => {
    const handoff = new CompactScreenshotHandoff();
    expect(handoff.read("last-floating-chat")).toBeNull();
    handoff.put({ ...image, threadId: handoff.selectedThreadId });
    expect(handoff.read("other-chat")?.threadId).toBe("last-floating-chat");
    expect(handoff.selectedThreadId).toBe("other-chat");
  });

  it("retries the same capture across reads and removes only the acknowledged ID", () => {
    const handoff = new CompactScreenshotHandoff();
    handoff.put({ ...image, threadId: null });
    const first = handoff.read("thread");
    expect(handoff.read("thread")).toEqual(first);
    expect(handoff.acknowledge("wrong-id")).toBe(false);
    expect(handoff.pending).toBe(true);
    expect(handoff.acknowledge(image.id)).toBe(true);
    expect(handoff.read("thread")).toBeNull();
  });

  it("bounds memory and preserves the first capture while delivery is pending", () => {
    const handoff = new CompactScreenshotHandoff();
    handoff.put({ ...image, threadId: null });
    expect(() => handoff.put({ ...image, id: "second", threadId: null })).toThrow(
      "already waiting",
    );
    expect(handoff.read("thread")?.id).toBe(image.id);
    handoff.clear();
    expect(handoff.pending).toBe(false);
    expect(handoff.selectedThreadId).toBeNull();
  });
});

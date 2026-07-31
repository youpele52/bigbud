import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { makeEvent } from "../../stores/main/main.store.test.helpers";
import { createThreadHydrationEventBuffer } from "./thread-hydration-events.logic";

function titleEvent(threadId: ThreadId, sequence: number, title: string) {
  return makeEvent(
    "thread.meta-updated",
    {
      threadId,
      title,
      updatedAt: "2026-07-30T00:00:00.000Z",
    },
    { sequence },
  );
}

describe("thread hydration event buffer", () => {
  it("releases a higher-sequence event after the detail response", () => {
    const buffer = createThreadHydrationEventBuffer();
    const threadId = ThreadId.makeUnsafe("thread-a");
    const token = buffer.begin(threadId);
    const event = titleEvent(threadId, 12, "New title");

    expect(buffer.bufferEvent(event)).toBe(true);
    expect(buffer.finish(threadId, token, 11)).toEqual([event]);
  });

  it("discards duplicate events already covered by the response projection", () => {
    const buffer = createThreadHydrationEventBuffer();
    const threadId = ThreadId.makeUnsafe("thread-a");
    const token = buffer.begin(threadId);
    buffer.bufferEvent(titleEvent(threadId, 12, "Covered title"));
    buffer.bufferEvent(titleEvent(threadId, 12, "Duplicate title"));

    expect(buffer.finish(threadId, token, 12)).toEqual([]);
  });

  it("isolates route-switch buffers and ignores superseded responses", () => {
    const buffer = createThreadHydrationEventBuffer();
    const threadA = ThreadId.makeUnsafe("thread-a");
    const threadB = ThreadId.makeUnsafe("thread-b");
    const tokenA = buffer.begin(threadA);
    const tokenB = buffer.begin(threadB);
    const eventA = titleEvent(threadA, 20, "A title");
    const eventB = titleEvent(threadB, 21, "B title");
    buffer.bufferEvent(eventA);
    buffer.bufferEvent(eventB);

    expect(buffer.finish(threadB, tokenB, 19)).toEqual([eventB]);
    expect(buffer.finish(threadA, tokenA, 19)).toEqual([eventA]);

    const superseded = buffer.begin(threadA);
    const current = buffer.begin(threadA);
    expect(buffer.finish(threadA, superseded, 21)).toBeNull();
    expect(buffer.finish(threadA, current, 21)).toEqual([]);
  });
});

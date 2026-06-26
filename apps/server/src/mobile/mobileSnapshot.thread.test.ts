import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { getThreadFromOrchestrationSnapshot } from "./mobileSnapshot.thread";

describe("getThreadFromOrchestrationSnapshot", () => {
  it("returns the matching thread when present", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const thread = {
      id: threadId,
      title: "Example",
    };

    expect(
      getThreadFromOrchestrationSnapshot(
        {
          snapshotSequence: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          projects: [],
          threads: [thread as never],
        },
        threadId,
      ),
    ).toBe(thread);
  });

  it("returns null when the thread is missing", () => {
    expect(
      getThreadFromOrchestrationSnapshot(
        {
          snapshotSequence: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          projects: [],
          threads: [],
        },
        ThreadId.makeUnsafe("missing"),
      ),
    ).toBeNull();
  });
});

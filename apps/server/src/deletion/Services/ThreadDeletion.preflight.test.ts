import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { threadSubtreeHasLiveActiveRuntime } from "./ThreadDeletion.preflight.ts";

const threadId = ThreadId.makeUnsafe("preflight-thread");

describe("threadSubtreeHasLiveActiveRuntime", () => {
  it("ignores a stale projected running session when no live provider session is active", () => {
    expect(
      threadSubtreeHasLiveActiveRuntime({
        threads: [{ id: threadId }],
        liveSessions: [],
      }),
    ).toBe(false);
  });

  it("blocks deletion only for live connecting or running provider sessions", () => {
    expect(
      threadSubtreeHasLiveActiveRuntime({
        threads: [{ id: threadId }],
        liveSessions: [{ threadId, status: "running" }],
      }),
    ).toBe(true);
    expect(
      threadSubtreeHasLiveActiveRuntime({
        threads: [{ id: threadId }],
        liveSessions: [{ threadId, status: "connecting" }],
      }),
    ).toBe(true);
    expect(
      threadSubtreeHasLiveActiveRuntime({
        threads: [{ id: threadId }],
        liveSessions: [{ threadId, status: "ready" }],
      }),
    ).toBe(false);
  });
});

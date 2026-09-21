import { ThreadId, TurnId, type ProviderSession } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { isLiveProviderSessionIdle } from "./liveProviderSessionIdle.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-idle");

function session(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    provider: "cursor",
    status: "ready",
    runtimeMode: "full-access",
    threadId: THREAD_ID,
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("isLiveProviderSessionIdle", () => {
  it("treats a ready session without an active turn as idle", () => {
    expect(isLiveProviderSessionIdle(session())).toBe(true);
  });

  it("treats leftover running or active-turn sessions as busy", () => {
    expect(isLiveProviderSessionIdle(undefined)).toBe(false);
    expect(isLiveProviderSessionIdle(session({ status: "running" }))).toBe(false);
    expect(isLiveProviderSessionIdle(session({ status: "connecting" }))).toBe(false);
    expect(isLiveProviderSessionIdle(session({ activeTurnId: TurnId.makeUnsafe("turn-1") }))).toBe(
      false,
    );
  });
});

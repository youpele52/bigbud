import { ThreadId, type OrchestrationSession, type ProviderSession } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { shouldStampRunningSessionAfterSend } from "./ProviderCommandReactorSessionOps.send.stamp.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

const readyLive: ProviderSession = {
  provider: "cursor",
  status: "ready",
  runtimeMode: "full-access",
  threadId: THREAD_ID,
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};

const readyOrchestration: OrchestrationSession = {
  threadId: THREAD_ID,
  status: "ready",
  providerName: "cursor",
  runtimeMode: "full-access",
  activeTurnId: null,
  sessionEpoch: 0,
  reason: null,
  lastError: null,
  updatedAt: "2026-09-21T00:00:00.000Z",
};

describe("shouldStampRunningSessionAfterSend", () => {
  it("skips the running stamp when the live adapter session is already idle", () => {
    expect(
      shouldStampRunningSessionAfterSend({
        liveSession: readyLive,
        sessionAfterTurn: readyOrchestration,
        sessionUnchangedSinceSend: true,
      }),
    ).toBe(false);
  });

  it("keeps the async-provider fallback when live work is still unmarked in orchestration", () => {
    expect(
      shouldStampRunningSessionAfterSend({
        liveSession: { ...readyLive, provider: "codex", status: "running" },
        sessionAfterTurn: readyOrchestration,
        sessionUnchangedSinceSend: true,
      }),
    ).toBe(true);
  });
});

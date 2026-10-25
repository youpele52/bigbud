import { EventId, type ProviderRuntimeEvent, ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { runtimeEventToActivitiesFromHelpers } from "./ProviderRuntimeIngestion.helpers.activities.ts";
import {
  toApprovalRequestId,
  toTurnId,
  truncateDetail,
} from "./ProviderRuntimeIngestion.helpers.ts";

const helpers = {
  toTurnId,
  toApprovalRequestId,
  truncateDetail,
  requestKindFromCanonicalRequestType: () => undefined,
  buildContextWindowActivityPayload: () => undefined,
};

const stateEvent = (state: "reset" | "idle"): ProviderRuntimeEvent => ({
  type: "thread.state.changed",
  eventId: EventId.makeUnsafe(`event-${state}`),
  provider: "claudeAgent",
  createdAt: "2026-10-16T00:00:00.000Z",
  threadId: ThreadId.makeUnsafe("thread-1"),
  turnId: TurnId.makeUnsafe("turn-1"),
  payload: { state, detail: { trigger: "clear", newConversationId: "conv-2" } },
});

describe("provider conversation reset activity", () => {
  it("shows a cleared-conversation info row and keeps other states silent", () => {
    expect(runtimeEventToActivitiesFromHelpers(stateEvent("reset"), helpers)).toMatchObject([
      {
        tone: "info",
        kind: "provider-conversation.reset",
        summary: "Provider conversation cleared",
        payload: { state: "reset", detail: { trigger: "clear", newConversationId: "conv-2" } },
        turnId: "turn-1",
      },
    ]);
    expect(runtimeEventToActivitiesFromHelpers(stateEvent("idle"), helpers)).toEqual([]);
  });
});

describe("runtime warning severity", () => {
  it("uses the red error tone only for error-severity warnings", () => {
    const warning = (severity?: "error"): ProviderRuntimeEvent => ({
      type: "runtime.warning",
      eventId: EventId.makeUnsafe(`warning-${severity ?? "default"}`),
      provider: "claudeAgent",
      createdAt: "2026-10-16T00:00:00.000Z",
      threadId: ThreadId.makeUnsafe("thread-1"),
      payload: { message: "Claude usage limit reached.", ...(severity ? { severity } : {}) },
    });
    expect(runtimeEventToActivitiesFromHelpers(warning("error"), helpers)[0]?.tone).toBe("error");
    expect(runtimeEventToActivitiesFromHelpers(warning(), helpers)[0]?.tone).toBe("info");
  });
});

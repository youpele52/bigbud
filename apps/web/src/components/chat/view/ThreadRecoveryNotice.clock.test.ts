import type { MessageId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadTurnStartRequest } from "../../../models/types/app.types";
import {
  MAX_TURN_START_OBSERVATIONS,
  observeThreadTurnStartRequest,
  turnStartObservationCount,
} from "./ThreadRecoveryNotice.clock";

const request: ThreadTurnStartRequest = {
  messageId: "user-1" as MessageId,
  requestedAt: "2026-10-15T10:00:00.000Z",
  outcome: "pending",
  settledAt: null,
  recoverySteps: [],
};

describe("browser-clock observations per thread", () => {
  it("stays bounded however many threads were seen, keeping the most recent", () => {
    for (let index = 0; index < MAX_TURN_START_OBSERVATIONS + 40; index += 1) {
      observeThreadTurnStartRequest(`thread-${index}` as ThreadId, request, index);
    }
    expect(turnStartObservationCount()).toBe(MAX_TURN_START_OBSERVATIONS);
    const newest = `thread-${MAX_TURN_START_OBSERVATIONS + 39}` as ThreadId;
    expect(observeThreadTurnStartRequest(newest, request, 999_999)?.observedAtMs).toBe(
      MAX_TURN_START_OBSERVATIONS + 39,
    );
  });

  it("forgets a thread once its request goes away", () => {
    const threadId = "thread-gone" as ThreadId;
    observeThreadTurnStartRequest(threadId, request, 1);
    const before = turnStartObservationCount();
    observeThreadTurnStartRequest(threadId, null, 2);
    expect(turnStartObservationCount()).toBe(before - 1);
  });
});

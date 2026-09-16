import type { OrchestrationEvent } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  MAX_CLIENT_RECOVERY_BYTES,
  createMobileRecoveryEventTracker,
  MAX_CLIENT_RECOVERY_EVENTS,
} from "./mobileRecovery.tracking";

function makeEvent(sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: `event-${sequence}`,
    type: "thread.message-sent",
  } as unknown as OrchestrationEvent;
}

describe("mobile recovery event tracking", () => {
  it("bounds replay identity retention instead of growing without limit", () => {
    const tracker = createMobileRecoveryEventTracker();

    for (let sequence = 1; sequence <= MAX_CLIENT_RECOVERY_EVENTS; sequence += 1) {
      expect(tracker.track(makeEvent(sequence), sequence - 1, false)).toBe("accepted");
    }

    expect(
      tracker.track(makeEvent(MAX_CLIENT_RECOVERY_EVENTS + 1), MAX_CLIENT_RECOVERY_EVENTS, false),
    ).toBe("overflow");
  });

  it("evicts old live identities only after catch-up has completed", () => {
    const tracker = createMobileRecoveryEventTracker();

    for (let sequence = 1; sequence <= MAX_CLIENT_RECOVERY_EVENTS; sequence += 1) {
      expect(tracker.track(makeEvent(sequence), sequence - 1, false)).toBe("accepted");
    }
    expect(
      tracker.track(makeEvent(MAX_CLIENT_RECOVERY_EVENTS + 1), MAX_CLIENT_RECOVERY_EVENTS, true),
    ).toBe("accepted");
    expect(tracker.track(makeEvent(1), MAX_CLIENT_RECOVERY_EVENTS + 1, true)).toBe(
      "identity-mismatch",
    );
  });

  it("rejects an oversized single event instead of bypassing the byte bound", () => {
    const tracker = createMobileRecoveryEventTracker();
    const event = {
      ...makeEvent(1),
      payload: { text: "x".repeat(MAX_CLIENT_RECOVERY_BYTES) },
    } as unknown as OrchestrationEvent;

    expect(tracker.track(event, 0, false)).toBe("overflow");
  });
});

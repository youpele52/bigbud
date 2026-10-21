import { describe, expect, it } from "vitest";

import {
  formatWsReconnectAttempt,
  isWsReconnectPastLabelCap,
  type WsConnectionStatus,
} from "../rpc/wsConnectionState";
import {
  shouldAutoReconnect,
  type WsAutoReconnectTrigger,
} from "./WebSocketConnectionSurface.logic";
import {
  buildReconnectingToast,
  buildRecoveredToast,
  describeReconnectingToast,
} from "./WebSocketConnectionSurface.toasts";

function makeStatus(overrides: Partial<WsConnectionStatus> = {}): WsConnectionStatus {
  return {
    attemptCount: 0,
    closeCode: null,
    closeReason: null,
    connectedAt: null,
    disconnectedAt: null,
    hasConnected: true,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    online: true,
    phase: "disconnected",
    reconnectAttemptCount: 2,
    reconnectMaxAttempts: 8,
    reconnectPhase: "waiting",
    socketUrl: null,
    ...overrides,
  };
}

const IMMEDIATE_TRIGGERS: readonly WsAutoReconnectTrigger[] = [
  "visible",
  "resume",
  "unlock",
  "online",
  "ready",
];

describe("immediate reconnect triggers", () => {
  it.each(IMMEDIATE_TRIGGERS)("%s reconnects a dropped link immediately", (trigger) => {
    expect(shouldAutoReconnect(makeStatus(), trigger)).toBe(true);
    // Even before the first successful connection, e.g. a backend that became ready.
    expect(shouldAutoReconnect(makeStatus({ hasConnected: false }), trigger)).toBe(true);
    expect(shouldAutoReconnect(makeStatus({ online: false }), trigger)).toBe(true);
  });

  it.each([...IMMEDIATE_TRIGGERS, "focus" as const])("%s ignores a live connection", (trigger) => {
    expect(
      shouldAutoReconnect(makeStatus({ phase: "connected", reconnectPhase: "idle" }), trigger),
    ).toBe(false);
  });

  it("keeps focus limited to links that were live before", () => {
    expect(shouldAutoReconnect(makeStatus(), "focus")).toBe(true);
    expect(shouldAutoReconnect(makeStatus({ hasConnected: false }), "focus")).toBe(false);
    expect(shouldAutoReconnect(makeStatus({ online: false }), "focus")).toBe(false);
  });
});

describe("reconnect toast semantics", () => {
  it("stays blue and labels attempts past the old cap without a denominator", () => {
    const early = makeStatus({ reconnectAttemptCount: 3 });
    expect(formatWsReconnectAttempt(early)).toBe("3/8");
    const late = makeStatus({ reconnectAttemptCount: 12 });
    expect(isWsReconnectPastLabelCap(late)).toBe(true);
    expect(formatWsReconnectAttempt(late)).toBe("12");
    const toast = buildReconnectingToast(late, Date.now(), () => undefined);
    expect(toast.type).toBe("loading");
    expect(toast.description).toBe("Reconnecting... Attempt 12");
    expect(toast.description).not.toMatch(/exhausted/i);
  });

  it("counts down to the jittered retry the schedule actually chose", () => {
    const nowMs = Date.parse("2026-10-21T10:00:00.000Z");
    const status = makeStatus({ nextRetryAt: "2026-10-21T10:00:07.200Z" });
    expect(describeReconnectingToast(status, nowMs)).toBe("Reconnecting in 8s... Attempt 2/8");
    expect(describeReconnectingToast({ ...status, reconnectPhase: "attempting" }, nowMs)).toBe(
      "Reconnecting... Attempt 2/8",
    );
  });

  it("turns green on success", () => {
    expect(buildRecoveredToast(null, null).type).toBe("success");
  });
});

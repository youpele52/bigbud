import { describe, expect, it, vi } from "vitest";

import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import {
  syncDeliveryRecoveryToast,
  shouldAutoReconnect,
  shouldRestartStalledReconnect,
} from "./WebSocketConnectionSurface.logic";

function makeStatus(overrides: Partial<WsConnectionStatus> = {}): WsConnectionStatus {
  return {
    attemptCount: 0,
    closeCode: null,
    closeReason: null,
    connectedAt: null,
    disconnectedAt: null,
    hasConnected: false,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    online: true,
    phase: "idle",
    reconnectAttemptCount: 0,
    reconnectMaxAttempts: 8,
    reconnectPhase: "idle",
    socketUrl: null,
    ...overrides,
  };
}

describe("WebSocketConnectionSurface.logic", () => {
  it("keeps one recovery toast until a reconnect is proven live", () => {
    const manager = {
      add: vi.fn(() => "delivery-toast"),
      close: vi.fn(),
      update: vi.fn(),
    };
    const delivery = {
      type: "lifecycle" as const,
      route: "supervisor" as const,
      consumerId: "consumer-1",
      consumerGeneration: 1,
      state: "reconnecting" as const,
      acknowledgedSequence: 4,
      restartAttempt: 1,
    };

    const toastId = syncDeliveryRecoveryToast(manager, null, delivery);
    const repeatedToastId = syncDeliveryRecoveryToast(manager, toastId, {
      ...delivery,
      restartAttempt: 2,
    });
    const attachingToastId = syncDeliveryRecoveryToast(manager, repeatedToastId, {
      ...delivery,
      state: "connecting",
    });
    const degradedAgainToastId = syncDeliveryRecoveryToast(manager, attachingToastId, {
      ...delivery,
      state: "fallback",
    });
    syncDeliveryRecoveryToast(manager, degradedAgainToastId, { ...delivery, state: "live" });

    expect(manager.add).toHaveBeenCalledOnce();
    expect(manager.update).toHaveBeenCalledTimes(3);
    expect(manager.close).toHaveBeenCalledWith("delivery-toast");
  });

  it("does not show recovery UI for an initial connection", () => {
    const manager = {
      add: vi.fn(() => "delivery-toast"),
      close: vi.fn(),
      update: vi.fn(),
    };

    expect(
      syncDeliveryRecoveryToast(manager, null, {
        type: "lifecycle",
        route: "supervisor",
        consumerId: "consumer-1",
        consumerGeneration: 1,
        state: "connecting",
        acknowledgedSequence: 0,
        restartAttempt: 0,
      }),
    ).toBeNull();
    expect(manager.add).not.toHaveBeenCalled();
  });
  it("retries on browser online after an initial connection failure", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: false,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
        "online",
      ),
    ).toBe(true);
  });

  it("retries on focus only after a live connection has been established", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 2,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(true);

    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: false,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(false);
  });

  it("restarts a stalled reconnect window after the scheduled retry time passes", () => {
    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(true);

    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "attempting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(false);
  });
});

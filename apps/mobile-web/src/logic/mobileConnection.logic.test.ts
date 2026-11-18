import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMobileConnectionLifecycle,
  isExplicitMobileAuthorizationClose,
  scheduleMobileConnectionExpiry,
} from "./mobileConnection.logic";

describe("mobile connection lifecycle evidence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps stale socket callbacks fenced after a new generation begins", () => {
    const lifecycle = createMobileConnectionLifecycle();
    const first = lifecycle.begin("2030-01-01T00:00:00.000Z");
    const second = lifecycle.begin("2030-01-01T00:00:00.000Z");

    expect(first.isActive()).toBe(false);
    expect(second.isActive()).toBe(true);
    first.handlers.onOpen?.();
    first.handlers.onExhausted?.();
    expect(lifecycle.getState()).toMatchObject({
      generation: second.generation,
      transport: "connecting",
    });

    second.handlers.onAttempt?.("ws://desktop/mobile-ws");
    second.handlers.onRetry?.({ retryCount: 2, delayMs: 2_000 });
    expect(lifecycle.getState()).toMatchObject({
      transport: "retrying",
      attempt: 1,
      retryCount: 2,
      retryDelayMs: 2_000,
    });
  });

  it("records a host-access-off close without treating it as an authorization rejection", () => {
    const lifecycle = createMobileConnectionLifecycle();
    const lease = lifecycle.begin("2030-01-01T00:00:00.000Z");
    lease.handlers.onClose?.({
      code: 4503,
      reason: "mobile remote control was turned off on this host",
    });
    expect(lifecycle.getState()).toMatchObject({
      hostAccessOff: true,
      authorization: "unknown",
    });
    // Later retries are refused at upgrade (opaque to browsers); the flag stays.
    lease.handlers.onClose?.({ code: 1006, reason: "" });
    expect(lifecycle.getState().hostAccessOff).toBe(true);
    lease.handlers.onOpen?.();
    expect(lifecycle.getState().hostAccessOff).toBe(false);
  });

  it("keeps generic close failures separate from explicit authorization evidence", () => {
    expect(isExplicitMobileAuthorizationClose({ code: 1006, reason: "network disappeared" })).toBe(
      false,
    );
    expect(isExplicitMobileAuthorizationClose({ code: 1008, reason: "session expired" })).toBe(
      true,
    );

    const lifecycle = createMobileConnectionLifecycle();
    const lease = lifecycle.begin("2030-01-01T00:00:00.000Z");
    lease.handlers.onClose?.({ code: 1006, reason: "network disappeared" });
    expect(lifecycle.getState().authorization).toBe("unknown");
    lease.handlers.onClose?.({ code: 1008, reason: "session expired" });
    expect(lifecycle.getState().authorization).toBe("explicitly-rejected");
  });

  it("marks expiry as a local authorization boundary and ignores disposed leases", () => {
    const lifecycle = createMobileConnectionLifecycle();
    const lease = lifecycle.begin("2030-01-01T00:00:00.000Z");
    const listener = vi.fn();
    lifecycle.subscribe(listener);

    lease.expire();
    expect(lifecycle.getState()).toMatchObject({
      authorization: "locally-expired",
      expired: true,
      transport: "closed",
    });
    const updates = listener.mock.calls.length;
    lease.handlers.onOpen?.();
    lease.dispose();
    lease.handlers.onRetry?.({ retryCount: 1, delayMs: 1_000 });
    expect(listener).toHaveBeenCalledTimes(updates);
  });

  it("arms and cancels the session expiry timer without relying on a UI retry timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const onExpired = vi.fn();
    const cancel = scheduleMobileConnectionExpiry({
      expiresAt: "2030-01-01T00:00:10.000Z",
      onExpired,
    });

    vi.advanceTimersByTime(9_999);
    expect(onExpired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpired).toHaveBeenCalledOnce();
    cancel();
  });

  it("does not expire immediately when expiry is beyond the 32-bit timer limit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const onExpired = vi.fn();
    const cancel = scheduleMobileConnectionExpiry({
      expiresAt: "2030-03-01T00:00:00.000Z",
      onExpired,
    });

    vi.advanceTimersByTime(1);
    expect(onExpired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(Date.parse("2030-03-01T00:00:00.000Z") - Date.now() - 1);
    expect(onExpired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpired).toHaveBeenCalledOnce();
    cancel();
  });

  it("cancels a far-future expiry before its re-armed timer fires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const onExpired = vi.fn();
    const cancel = scheduleMobileConnectionExpiry({
      expiresAt: "2099-01-01T00:00:00.000Z",
      onExpired,
    });
    vi.advanceTimersByTime(2_147_483_647);
    cancel();
    vi.advanceTimersByTime(10 * 2_147_483_647);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("publishes reconnect thresholds from one incident clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const lifecycle = createMobileConnectionLifecycle();
    const lease = lifecycle.begin("2030-01-01T00:01:00.000Z");

    expect(lifecycle.getState().incidentLevel).toBe("short");
    vi.advanceTimersByTime(1_999);
    expect(lifecycle.getState().incidentLevel).toBe("short");
    vi.advanceTimersByTime(1);
    expect(lifecycle.getState().incidentLevel).toBe("reconnecting");
    vi.advanceTimersByTime(7_999);
    expect(lifecycle.getState().incidentLevel).toBe("reconnecting");
    vi.advanceTimersByTime(1);
    expect(lifecycle.getState().incidentLevel).toBe("escalated");

    lease.handlers.onOpen?.();
    expect(lifecycle.getState()).toMatchObject({
      incidentLevel: "none",
      incidentStartedAt: null,
      transport: "open",
    });
  });

  it("restarts incident timing after a healthy socket closes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const lifecycle = createMobileConnectionLifecycle();
    const lease = lifecycle.begin("2030-01-01T00:01:00.000Z");
    lease.handlers.onOpen?.();
    vi.advanceTimersByTime(30_000);
    lease.handlers.onClose?.({ code: 1006, reason: "network disappeared" });

    expect(lifecycle.getState().incidentStartedAt).toBe(Date.now());
    expect(lifecycle.getState().incidentLevel).toBe("short");
    vi.advanceTimersByTime(2_000);
    expect(lifecycle.getState().incidentLevel).toBe("reconnecting");
  });

  it("keeps browser offline advisory state separate from authorization", () => {
    const lifecycle = createMobileConnectionLifecycle();
    lifecycle.setBrowserOffline(true);
    expect(lifecycle.getState()).toMatchObject({ browserOffline: true, authorization: "unknown" });
    lifecycle.setBrowserOffline(false);
    expect(lifecycle.getState().browserOffline).toBe(false);
  });
});

describe("server session-ended close", () => {
  it("classifies the backend's 4401 session-ended close as an explicit rejection", () => {
    for (const reason of [
      "unauthorized: mobile session revoked",
      "unauthorized: mobile session expired",
    ]) {
      expect(isExplicitMobileAuthorizationClose({ code: 4401, reason })).toBe(true);
    }
    // A vanished backend relayed by the gateway stays a retryable network event.
    expect(isExplicitMobileAuthorizationClose({ code: 1013, reason: "" })).toBe(false);
  });
});

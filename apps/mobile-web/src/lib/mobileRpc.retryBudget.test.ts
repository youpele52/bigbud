import * as Effect from "effect/Effect";
import { afterEach, expect, it, vi } from "vitest";

import { createMobileRpcReconnectPolicy } from "./mobileRpc.protocol";
import { createMobileConnectionLifecycle } from "../logic/mobileConnection.logic";
import { initialMobileRecoveryState } from "../logic/mobileRecovery.types";
import { isMobileStartupWaiting } from "../components/shell/MobileSessionGate.logic";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reports actual retry termination after an initial successful open", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const construct = vi.fn(function () {
    return new EventTarget();
  });
  vi.stubGlobal("WebSocket", construct);
  const lifecycle = createMobileConnectionLifecycle();
  const lease = lifecycle.begin("2099-01-01T00:00:00Z");
  const { createSocket, retryPolicy } = createMobileRpcReconnectPolicy(lease.handlers);
  let first = true;
  const run = Effect.runPromise(
    Effect.suspend(() => {
      const socket = createSocket("ws://fixture/mobile-ws");
      if (first) {
        socket.dispatchEvent(new Event("open"));
        first = false;
      }
      const close = new Event("close");
      Object.assign(close, { code: 1006, reason: "network" });
      socket.dispatchEvent(close);
      return Effect.fail({ _tag: "Closed" as const });
    }).pipe(Effect.retry(retryPolicy), Effect.ignore),
  );
  await vi.advanceTimersByTimeAsync(40_000);
  await run;
  expect(construct).toHaveBeenCalledTimes(8);
  expect(lifecycle.getState().transport).toBe("exhausted");
  expect(
    isMobileStartupWaiting(lifecycle.getState(), initialMobileRecoveryState("unavailable"), true),
  ).toBe(false);
  lease.dispose();
});

it("keeps exhaustion when the final socket close arrives after retry termination", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.stubGlobal(
    "WebSocket",
    vi.fn(function () {
      return new EventTarget();
    }),
  );
  const lifecycle = createMobileConnectionLifecycle();
  const lease = lifecycle.begin("2099-01-01T00:00:00Z");
  const { createSocket, retryPolicy } = createMobileRpcReconnectPolicy(lease.handlers);
  let last!: WebSocket;
  const run = Effect.runPromise(
    Effect.suspend(() => {
      last = createSocket("ws://fixture/mobile-ws");
      last.dispatchEvent(new Event("error"));
      return Effect.fail({ _tag: "ErrorBeforeClose" as const });
    }).pipe(Effect.retry(retryPolicy), Effect.ignore),
  );
  await vi.advanceTimersByTimeAsync(40_000);
  await run;
  expect(lifecycle.getState().transport).toBe("exhausted");
  const close = new Event("close");
  Object.assign(close, { code: 1006, reason: "network" });
  last.dispatchEvent(close);
  expect(lifecycle.getState().transport).toBe("exhausted");
  expect(lifecycle.getState().incidentLevel).toBe("escalated");
  expect(
    isMobileStartupWaiting(lifecycle.getState(), initialMobileRecoveryState("unavailable"), true),
  ).toBe(false);
  lease.handlers.onClose?.({ code: 4401, reason: "unauthorized: revoked" });
  lease.handlers.onExhausted?.();
  expect(lifecycle.getState().authorization).toBe("explicitly-rejected");
  expect(lifecycle.getState().transport).toBe("closed");
  lease.dispose();
});

it.each([
  [0, 19_500],
  [1, 39_000],
])("exhausts exactly eight attempts at jitter %s", async (random, duration) => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(random!);
  vi.stubGlobal(
    "WebSocket",
    vi.fn(function () {
      return new EventTarget();
    }),
  );
  const started = Date.now();
  const exhausted: number[] = [];
  const attempts: number[] = [];
  const { createSocket, retryPolicy } = createMobileRpcReconnectPolicy({
    onAttempt: () => attempts.push(Date.now() - started),
    onExhausted: () => exhausted.push(Date.now() - started),
  });
  const run = Effect.runPromise(
    Effect.suspend(() => {
      const socket = createSocket("ws://fixture/mobile-ws");
      const close = new Event("close");
      Object.assign(close, { code: 1006, reason: "network" });
      socket.dispatchEvent(close);
      return Effect.fail({ _tag: "Refused" as const });
    }).pipe(Effect.retry(retryPolicy), Effect.ignore),
  );
  await vi.advanceTimersByTimeAsync(40_000);
  await run;
  expect(attempts).toHaveLength(8);
  expect(exhausted).toEqual([duration]);
});

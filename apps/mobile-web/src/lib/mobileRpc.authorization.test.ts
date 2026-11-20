import * as Effect from "effect/Effect";
import { afterEach, expect, it, vi } from "vitest";

import { createMobileRpcReconnectPolicy } from "./mobileRpc.protocol";
import { createMobileConnectionLifecycle } from "../logic/mobileConnection.logic";
import {
  canRestartMobileConnection,
  resolveMobileResumeAction,
} from "../logic/mobileConnection.resume";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("stops protocol retries after a revoked socket and preserves rejection until reset", async () => {
  const socket = new EventTarget();
  vi.stubGlobal(
    "WebSocket",
    vi.fn(function () {
      return socket;
    }),
  );
  const lifecycle = createMobileConnectionLifecycle();
  const lease = lifecycle.begin("2099-01-01T00:00:00Z");
  const { createSocket, retryPolicy } = createMobileRpcReconnectPolicy(lease.handlers);
  createSocket("ws://fixture/mobile-ws");
  const close = new Event("close");
  Object.assign(close, { code: 4401, reason: "unauthorized: mobile session revoked" });
  socket.dispatchEvent(close);
  let attempts = 0;
  await Effect.runPromise(
    Effect.sync(() => {
      attempts += 1;
    }).pipe(
      Effect.andThen(Effect.fail({ _tag: "TestClosed" as const })),
      Effect.retry(retryPolicy),
      Effect.ignore,
    ),
  );
  expect(attempts).toBe(1);
  expect(canRestartMobileConnection(lifecycle.getState())).toBe(false);
  expect(
    resolveMobileResumeAction({
      visible: true,
      sessionExpired: false,
      transport: "closed",
      authorization: lifecycle.getState().authorization,
    }),
  ).toBe("none");
  lease.dispose();
  const next = lifecycle.begin("2099-01-01T00:00:00Z");
  expect(lifecycle.getState().authorization).toBe("explicitly-rejected");
  next.handlers.onOpen?.();
  expect(lifecycle.getState().authorization).toBe("explicitly-rejected");
  next.dispose();
  lifecycle.reset();
  expect(canRestartMobileConnection(lifecycle.getState())).toBe(true);
});

it("does not acquire a socket when revocation arrives during an already scheduled backoff", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
  const socket = new EventTarget();
  const construct = vi.fn(function () {
    return socket;
  });
  vi.stubGlobal("WebSocket", construct);
  const onRetry = vi.fn();
  const onExhausted = vi.fn();
  const lifecycle = createMobileConnectionLifecycle();
  const lease = lifecycle.begin("2099-01-01T00:00:00Z");
  const { createSocket, retryPolicy } = createMobileRpcReconnectPolicy({
    ...lease.handlers,
    onRetry,
    onExhausted,
  });
  const result = Effect.runPromiseExit(
    Effect.suspend(() => {
      createSocket("ws://fixture/mobile-ws");
      return Effect.fail({ _tag: "SocketFailedBeforeClose" as const });
    }).pipe(Effect.retry(retryPolicy)),
  );
  await vi.advanceTimersByTimeAsync(250);
  expect(onRetry).toHaveBeenCalledOnce();
  const close = new Event("close");
  Object.assign(close, { code: 4401, reason: "unauthorized: revoked" });
  socket.dispatchEvent(close);
  await vi.advanceTimersByTimeAsync(40_000);
  await result;
  expect(construct).toHaveBeenCalledOnce();
  expect(onExhausted).not.toHaveBeenCalled();
  expect(lifecycle.getState().authorization).toBe("explicitly-rejected");
  lease.dispose();
});

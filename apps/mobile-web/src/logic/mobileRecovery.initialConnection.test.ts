import { afterEach, expect, it, vi } from "vitest";

import { createMobileRecoveryController } from "./mobileRecovery.controller";
import { createMobileConnectionLifecycle } from "./mobileConnection.logic";
import { isMobileStartupWaiting } from "../components/shell/MobileSessionGate.logic";
import { MobileRecoveryRejectedBaselineError } from "../lib/mobileRpc.errors";
import {
  makeBaseline,
  makeClient,
  makeQueryClient,
  makeStreamHarness,
  sessionId,
} from "./mobileRecovery.test.utils";

const scheduler = {
  queueMicrotask,
  setTimeout: (fn: () => void, ms: number) => Number(setTimeout(fn, ms)),
  clearTimeout: (id: number) => clearTimeout(id),
};
afterEach(() => vi.useRealTimers());

it("waits through refused sockets and recovers after a late first open", async () => {
  vi.useFakeTimers();
  let online = false;
  const readBaseline = vi.fn(async ({ recoveryAttemptId }: { recoveryAttemptId: string }) => {
    if (!online) throw new Error("unreachable");
    return makeBaseline(recoveryAttemptId, 0);
  });
  const controller = createMobileRecoveryController({
    client: makeClient({ readBaseline, stream: makeStreamHarness() }),
    queryClient: makeQueryClient(),
    sessionId,
    scheduler,
  });
  const connection = createMobileConnectionLifecycle();
  const lease = connection.begin("2099-01-01T00:00:00Z");
  controller.start();
  for (let attempt = 0; attempt < 7; attempt++) {
    lease.handlers.onAttempt?.("ws://fixture");
    lease.handlers.onClose?.({ code: 1006, reason: "unreachable" });
    controller.transportClosed();
    lease.handlers.onRetry?.({ retryCount: attempt, delayMs: 4_000 });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(isMobileStartupWaiting(connection.getState(), controller.getState(), false)).toBe(true);
  }
  expect(readBaseline).toHaveBeenCalledTimes(1);
  lease.handlers.onExhausted?.();
  expect(isMobileStartupWaiting(connection.getState(), controller.getState(), false)).toBe(false);
  online = true;
  lease.handlers.onOpen?.();
  controller.transportOpened();
  await vi.advanceTimersByTimeAsync(500);
  expect(readBaseline).toHaveBeenCalledTimes(2);
  expect(controller.getState().freshness).toBe("refreshing");
  controller.dispose();
  lease.dispose();
});

it("keeps a scheduled retry waiting when the failed socket closes afterward", () => {
  const connection = createMobileConnectionLifecycle();
  const lease = connection.begin("2099-01-01T00:00:00Z");
  lease.handlers.onAttempt?.("ws://fixture");
  lease.handlers.onRetry?.({ retryCount: 0, delayMs: 1000 });
  lease.handlers.onClose?.({ code: 1006, reason: "network" });
  expect(connection.getState().transport).toBe("retrying");
  lease.dispose();
});

it("does not rebuild a rejected baseline on timers or resume; explicit refresh retries", async () => {
  vi.useFakeTimers();
  const readBaseline = vi.fn(async () => {
    throw new MobileRecoveryRejectedBaselineError("Too large");
  });
  const controller = createMobileRecoveryController({
    client: makeClient({ readBaseline, stream: makeStreamHarness() }),
    queryClient: makeQueryClient(),
    sessionId,
    scheduler,
  });
  controller.start();
  await vi.advanceTimersByTimeAsync(60_000);
  controller.resumed();
  controller.transportOpened();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(readBaseline).toHaveBeenCalledTimes(1);
  await expect(controller.refresh()).rejects.toThrow("Too large");
  expect(readBaseline).toHaveBeenCalledTimes(2);
  controller.dispose();
});

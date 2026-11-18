import { ThreadId } from "@bigbud/contracts";
import { afterEach, expect, it, vi } from "vitest";

import { createMobileRecoveryController } from "./mobileRecovery.controller";
import { createMobileRecoveryRejection } from "./mobileRecovery.rejection";
import { createMobileConnectionLifecycle } from "./mobileConnection.logic";
import { resolveMobileResumeAction } from "./mobileConnection.resume";
import { MobileRecoveryRejectedBaselineError } from "../lib/mobileRpc.errors";
import {
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

it("retains a permanent rejection through exhaustion and automatic same-session replacement", async () => {
  vi.useFakeTimers();
  const rejection = createMobileRecoveryRejection();
  const threadId = ThreadId.makeUnsafe("too-large-thread");
  rejection.select(threadId);
  const readBaseline = vi.fn(async () => {
    throw new MobileRecoveryRejectedBaselineError("Too large");
  });
  const makeController = (shared = rejection) =>
    createMobileRecoveryController({
      client: makeClient({ readBaseline, stream: makeStreamHarness() }),
      queryClient: makeQueryClient(),
      sessionId,
      scheduler,
      rejection: shared,
    });
  const first = makeController();
  first.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(readBaseline).toHaveBeenCalledTimes(1);
  first.transportClosed();
  const lifecycle = createMobileConnectionLifecycle();
  const lease = lifecycle.begin("2099-01-01T00:00:00Z");
  lease.handlers.onExhausted?.();
  expect(
    resolveMobileResumeAction({
      visible: true,
      sessionExpired: false,
      transport: lifecycle.getState().transport,
    }),
  ).toBe("restart");
  first.dispose();
  await expect(first.refresh(null)).rejects.toThrow("disposed");
  expect(rejection.selectedThreadId).toBe(threadId);
  expect(rejection.error?.message).toBe("Too large");

  const replacement = makeController();
  replacement.start();
  replacement.transportOpened();
  replacement.resumed();
  await expect(replacement.selectThread(threadId)).rejects.toThrow("Too large");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(readBaseline).toHaveBeenCalledTimes(1);
  expect(replacement.getState().reason).toBe("Too large");
  expect(replacement.getState().selectedThreadId).toBe(threadId);
  await expect(replacement.refresh()).rejects.toThrow("Too large");
  expect(readBaseline).toHaveBeenCalledTimes(2);
  replacement.dispose();

  // The explicit Retry action clears the session-owned latch before replacing the RPC client.
  rejection.clear();
  const explicit = makeController();
  explicit.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(readBaseline).toHaveBeenCalledTimes(3);
  explicit.dispose();

  // A changed session gets a separate owner; a changed selected scope is also eligible.
  const newSession = makeController(createMobileRecoveryRejection());
  newSession.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(readBaseline).toHaveBeenCalledTimes(4);
  newSession.dispose();
  const changedScope = makeController();
  changedScope.start();
  await expect(changedScope.selectThread(ThreadId.makeUnsafe("other-thread"))).rejects.toThrow(
    "Too large",
  );
  expect(readBaseline).toHaveBeenCalledTimes(5);
  changedScope.dispose();
  lease.dispose();
});

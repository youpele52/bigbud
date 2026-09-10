import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileRecoveryUnsupportedError } from "../lib/mobileRpc.errors";
import { createMobileRecoveryController } from "./mobileRecovery.controller";
import {
  createMobileRecoveryStabilityTimer,
  MOBILE_RECOVERY_STABLE_SUCCESS_MS,
} from "./mobileRecovery.stability";
import {
  makeBaseline,
  makeClient,
  makeFrame,
  makeQueryClient,
  makeStreamHarness,
} from "./mobileRecovery.test.utils";

const scheduler = {
  queueMicrotask,
  setTimeout: (fn: () => void, ms: number) => Number(setTimeout(fn, ms)),
  clearTimeout: (id: number) => clearTimeout(id),
};
function setup(legacy: boolean) {
  const stream = makeStreamHarness();
  const readBaseline = vi.fn(async ({ recoveryAttemptId }: { recoveryAttemptId: string }) => {
    if (legacy) throw new MobileRecoveryUnsupportedError("mobile.recovery.getBaseline");
    return makeBaseline(recoveryAttemptId, 0);
  });
  const controller = createMobileRecoveryController({
    client: makeClient({ stream, readBaseline }),
    queryClient: makeQueryClient(),
    sessionId: "stability",
    scheduler,
  });
  async function succeed() {
    await vi.advanceTimersByTimeAsync(0);
    if (!legacy) {
      const run = stream.runs.at(-1)!;
      run.dispatchFrame(
        makeFrame(run.recoveryAttemptId, { type: "caught-up", throughSequence: 0 }),
      );
    }
    expect(controller.getState().freshness).toBe(legacy ? "legacy" : "current");
  }
  return { controller, readBaseline, succeed };
}
afterEach(() => vi.useRealTimers());

describe.each([false, true])("stable recovery replenishment (legacy=%s)", (legacy) => {
  it("automatically recovers six independent outages separated by stable success", async () => {
    vi.useFakeTimers();
    const { controller, readBaseline, succeed } = setup(legacy);
    controller.start();
    await succeed();
    for (let cycle = 0; cycle < 6; cycle++) {
      await vi.advanceTimersByTimeAsync(MOBILE_RECOVERY_STABLE_SUCCESS_MS);
      controller.transportClosed();
      controller.transportOpened();
      await vi.advanceTimersByTimeAsync(500);
      expect(readBaseline).toHaveBeenCalledTimes(cycle + 2);
      await succeed();
    }
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replenish interrupted success windows or revive exhausted retries by waiting", async () => {
    vi.useFakeTimers();
    const { controller, readBaseline, succeed } = setup(legacy);
    controller.start();
    await succeed();
    for (let cycle = 0; cycle < 3; cycle++) {
      await vi.advanceTimersByTimeAsync(MOBILE_RECOVERY_STABLE_SUCCESS_MS - 1);
      controller.transportClosed();
      for (let i = 0; i < 20; i++) controller.transportOpened();
      await vi.advanceTimersByTimeAsync([500, 1_000, 2_000][cycle]!);
      await succeed();
    }
    await vi.advanceTimersByTimeAsync(MOBILE_RECOVERY_STABLE_SUCCESS_MS - 1);
    controller.transportClosed();
    controller.transportOpened();
    await vi.advanceTimersByTimeAsync(MOBILE_RECOVERY_STABLE_SUCCESS_MS * 2);
    expect(readBaseline).toHaveBeenCalledTimes(4);
    expect(controller.getState().freshness).toBe("stale");
    await controller.refresh();
    await succeed();
    controller.transportClosed();
    controller.transportOpened();
    await vi.advanceTimersByTimeAsync(500);
    expect(readBaseline).toHaveBeenCalledTimes(6);
    controller.dispose();
  });

  it("cancels the old session's stable timer when its controller is disposed", async () => {
    vi.useFakeTimers();
    const old = setup(legacy);
    old.controller.start();
    await old.succeed();
    await vi.advanceTimersByTimeAsync(MOBILE_RECOVERY_STABLE_SUCCESS_MS - 1);
    old.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    const next = setup(legacy);
    next.controller.start();
    await next.succeed();
    await vi.advanceTimersByTimeAsync(1);
    expect(old.readBaseline).toHaveBeenCalledTimes(1);
    expect(next.readBaseline).toHaveBeenCalledTimes(1);
    next.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("stable-success timer lifecycle", () => {
  it("resets at the exact boundary without repeated success updates postponing it", async () => {
    vi.useFakeTimers();
    const reset = vi.fn();
    const timer = createMobileRecoveryStabilityTimer(scheduler, reset);
    timer.update("current");
    await vi.advanceTimersByTimeAsync(MOBILE_RECOVERY_STABLE_SUCCESS_MS - 1);
    timer.update("current");
    expect(reset).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reset).toHaveBeenCalledOnce();
    timer.update("current");
    expect(vi.getTimerCount()).toBe(0);
    timer.cancel();
  });

  it("fences a cancelled callback even if the scheduler delivers it late", () => {
    let callback = () => {};
    const reset = vi.fn();
    const timer = createMobileRecoveryStabilityTimer(
      {
        ...scheduler,
        setTimeout: (fn) => {
          callback = fn;
          return 1;
        },
        clearTimeout: vi.fn(),
      },
      reset,
    );
    timer.update("legacy");
    const previous = callback;
    timer.cancel();
    timer.update("current");
    previous();
    expect(reset).not.toHaveBeenCalled();
    callback();
    expect(reset).toHaveBeenCalledOnce();
    timer.cancel();
  });
});

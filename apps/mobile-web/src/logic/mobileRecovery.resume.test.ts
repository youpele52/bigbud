import { afterEach, describe, expect, it, vi } from "vitest";

import { createMobileRecoveryController } from "./mobileRecovery.controller";
import {
  makeBaseline,
  makeClient,
  makeFrame,
  makeQueryClient,
  makeStreamHarness,
  sessionId,
} from "./mobileRecovery.test.utils";

const scheduler = {
  queueMicrotask: (fn: () => void) => queueMicrotask(fn),
  setTimeout: (fn: () => void, ms: number) => Number(setTimeout(fn, ms)),
  clearTimeout: (id: number) => clearTimeout(id),
};

function setup() {
  vi.useFakeTimers();
  const readBaseline = vi.fn(async ({ recoveryAttemptId }: { recoveryAttemptId: string }) =>
    makeBaseline(recoveryAttemptId, 0),
  );
  const stream = makeStreamHarness();
  const controller = createMobileRecoveryController({
    client: makeClient({ readBaseline, stream }),
    queryClient: makeQueryClient(),
    sessionId,
    scheduler,
  });
  return { controller, stream, readBaseline };
}

afterEach(() => vi.useRealTimers());

describe("mobile recovery on page resume", () => {
  it("recovers again when automatic retries ran out while the page was away", async () => {
    const { controller, stream, readBaseline } = setup();
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    // Exhaust the automatic budget the same way a reconnect storm does.
    for (let i = 0; i < 12; i++) {
      const run = stream.runs.at(-1)!;
      run.dispatchFrame(
        makeFrame(run.recoveryAttemptId, { type: "caught-up", throughSequence: 0 }),
      );
      controller.transportClosed();
      controller.transportOpened();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(controller.getState().freshness).toBe("stale");
    const exhaustedCalls = readBaseline.mock.calls.length;

    controller.resumed();
    await vi.advanceTimersByTimeAsync(0);
    expect(readBaseline).toHaveBeenCalledTimes(exhaustedCalls + 1);
    controller.dispose();
  });

  it("does nothing on resume while recovery is current", async () => {
    const { controller, stream, readBaseline } = setup();
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const run = stream.runs.at(-1)!;
    run.dispatchFrame(makeFrame(run.recoveryAttemptId, { type: "caught-up", throughSequence: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState().freshness).toBe("current");
    const calls = readBaseline.mock.calls.length;

    controller.resumed();
    await vi.advanceTimersByTimeAsync(0);
    expect(readBaseline).toHaveBeenCalledTimes(calls);
    controller.dispose();
  });

  it("leaves a pending automatic retry in charge instead of adding another", async () => {
    const { controller, readBaseline } = setup();
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    controller.transportClosed();
    controller.transportOpened(); // schedules the next automatic retry
    const calls = readBaseline.mock.calls.length;

    controller.resumed();
    await vi.advanceTimersByTimeAsync(0);
    expect(readBaseline).toHaveBeenCalledTimes(calls);
    controller.dispose();
  });
});

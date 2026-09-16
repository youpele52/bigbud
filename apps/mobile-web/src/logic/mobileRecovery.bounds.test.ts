import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileRecoveryUnsupportedError } from "../lib/mobileRpc.errors";
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
function setup(
  readBaseline = vi.fn(async ({ recoveryAttemptId }: { recoveryAttemptId: string }) =>
    makeBaseline(recoveryAttemptId, 0),
  ),
) {
  vi.useFakeTimers();
  const stream = makeStreamHarness();
  const client = makeClient({ readBaseline, stream });
  const controller = createMobileRecoveryController({
    client,
    queryClient: makeQueryClient(),
    sessionId,
    scheduler,
  });
  return { controller, client, stream, readBaseline };
}
afterEach(() => vi.useRealTimers());

describe("mobile automatic recovery bounds", () => {
  it("caps reconnect storms including repeated successful catch-up until explicit Retry", async () => {
    const { controller, stream, readBaseline } = setup();
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 12; i++) {
      const run = stream.runs.at(-1)!;
      run.dispatchFrame(
        makeFrame(run.recoveryAttemptId, { type: "caught-up", throughSequence: 0 }),
      );
      controller.transportClosed();
      for (let open = 0; open < 20; open++) controller.transportOpened();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(readBaseline).toHaveBeenCalledTimes(4);
    expect(controller.getState().freshness).toBe("stale");
    await controller.refresh();
    expect(readBaseline).toHaveBeenCalledTimes(5);
    controller.dispose();
  });

  it("shares the baseline deadline with a hanging legacy read and aborts it", async () => {
    const { controller, client } = setup(
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        throw new MobileRecoveryUnsupportedError("mobile.recovery.getBaseline");
      }),
    );
    let signal: AbortSignal | undefined;
    client.getSnapshot = vi.fn((abort?: AbortSignal) => {
      signal = abort;
      return new Promise(() => {});
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(controller.getState().reason).toBe("recovery-timeout");
    controller.dispose();
  });

  it("preserves the remaining deadline when a stream switches to legacy", async () => {
    const { controller, client } = setup();
    let onError: ((error: unknown) => void) | undefined;
    client.startMobileRecoveryStream = (
      input: Parameters<typeof client.startMobileRecoveryStream>[0],
    ) => {
      onError = (input as { onError?: (error: unknown) => void }).onError;
      return vi.fn();
    };
    let signal: AbortSignal | undefined;
    client.getSnapshot = vi.fn((abort?: AbortSignal) => {
      signal = abort;
      return new Promise(() => {});
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(19_000);
    onError?.(new MobileRecoveryUnsupportedError("mobile.recovery.subscribe"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signal?.aborted).toBe(true);
    expect(controller.getState().reason).toBe("recovery-timeout");
    controller.dispose();
  });

  it("records successful legacy refresh separately and keeps it on failure", async () => {
    const { controller, client } = setup(
      vi.fn(async () => {
        throw new MobileRecoveryUnsupportedError("mobile.recovery.getBaseline");
      }),
    );
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const refreshed = controller.getState().lastRefreshedAt;
    expect(refreshed).toBe(Date.now());
    expect(controller.getState().lastSynchronizedAt).toBeNull();
    client.getSnapshot.mockRejectedValueOnce(new Error("unauthorized"));
    await expect(controller.refresh()).rejects.toThrow("unauthorized");
    expect(controller.getState().lastRefreshedAt).toBe(refreshed);
    controller.dispose();
  });
});

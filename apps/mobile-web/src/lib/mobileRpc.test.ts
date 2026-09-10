import { describe, expect, it, vi } from "vitest";
import { Effect, Stream } from "effect";

import { MOBILE_RECOVERY_WS_METHODS } from "@bigbud/contracts/server/mobile.recovery";
import { MobileRpcClient } from "./mobileRpc";

type StreamRun = {
  readonly cancel: () => void;
  readonly dispatchEvent: (event: unknown) => void;
  readonly exitUnexpectedly: () => void;
};

function createDomainEventStreamHarness() {
  const runs: StreamRun[] = [];
  const cancellations = vi.fn();

  return {
    startDomainEventStream: ({
      dispatchEvent,
      onExit,
    }: {
      readonly dispatchEvent: (event: unknown) => void;
      readonly onExit: () => void;
    }) => {
      let active = true;
      const run: StreamRun = {
        cancel: () => {
          if (!active) {
            return;
          }
          active = false;
          cancellations();
        },
        dispatchEvent: (event) => {
          if (active) {
            dispatchEvent(event);
          }
        },
        exitUnexpectedly: () => {
          if (!active) {
            return;
          }
          active = false;
          onExit();
        },
      };
      runs.push(run);
      return run.cancel;
    },
    runs,
    cancellations,
  };
}

function createTestRuntime() {
  return {
    dispose: vi.fn(),
    runCallback: vi.fn(() => () => undefined),
    runPromise: vi.fn(async <T>() => undefined as T),
    runSync: vi.fn(<T>() => ({}) as T),
  };
}

describe("MobileRpcClient domain event lifecycle", () => {
  it("rejects a cancellable request when the runtime cannot start it", async () => {
    const runtime = createTestRuntime();
    runtime.runCallback.mockImplementation(() => {
      throw new Error("runtime stopped");
    });
    const client = new MobileRpcClient("ws://localhost/mobile-ws", undefined, {
      clientPromise: Promise.resolve({} as never),
      runtime: runtime as never,
    });

    await expect(client.getSnapshot()).rejects.toThrow("runtime stopped");
    await client.dispose();
  });

  it("restarts the mobile domain event stream after an unexpected exit and continues delivery", async () => {
    const harness = createDomainEventStreamHarness();
    const runtime = createTestRuntime();
    const client = new MobileRpcClient("ws://localhost/mobile-ws", undefined, {
      clientPromise: Promise.resolve({} as never),
      runtime: runtime as never,
      startDomainEventStream: harness.startDomainEventStream,
    });
    const received: unknown[] = [];

    const unsubscribe = client.onDomainEvent((event) => {
      received.push(event);
    });

    expect(harness.runs).toHaveLength(1);

    harness.runs[0]?.dispatchEvent({ type: "first" });
    harness.runs[0]?.exitUnexpectedly();

    await Promise.resolve();

    expect(harness.runs).toHaveLength(2);

    harness.runs[1]?.dispatchEvent({ type: "second" });

    expect(received).toEqual([{ type: "first" }, { type: "second" }]);

    unsubscribe();
    await client.dispose();
  });

  it("does not restart the stream after the last listener unsubscribes", async () => {
    const harness = createDomainEventStreamHarness();
    const runtime = createTestRuntime();
    const client = new MobileRpcClient("ws://localhost/mobile-ws", undefined, {
      clientPromise: Promise.resolve({} as never),
      runtime: runtime as never,
      startDomainEventStream: harness.startDomainEventStream,
    });

    const unsubscribe = client.onDomainEvent(() => undefined);
    expect(harness.runs).toHaveLength(1);

    unsubscribe();
    harness.runs[0]?.exitUnexpectedly();
    await Promise.resolve();

    expect(harness.runs).toHaveLength(1);
    expect(harness.cancellations).toHaveBeenCalledOnce();

    await client.dispose();
  });

  it("sends the baseline server epoch when opening recovery", async () => {
    const subscribe = vi.fn(() => Stream.empty);
    const runtime = {
      dispose: vi.fn(),
      runCallback: (effect: unknown, options?: { readonly onExit?: (exit: unknown) => void }) => {
        void Effect.runPromiseExit(effect as Effect.Effect<unknown, never, never>).then((exit) => {
          options?.onExit?.(exit);
        });
        return () => undefined;
      },
      runPromise: vi.fn(async <T>() => undefined as T),
      runSync: vi.fn(<T>() => ({}) as T),
    };
    const client = new MobileRpcClient("ws://localhost/mobile-ws", undefined, {
      clientPromise: Promise.resolve({
        [MOBILE_RECOVERY_WS_METHODS.subscribe]: subscribe,
      } as never),
      runtime: runtime as never,
    });

    client.startMobileRecoveryStream({
      recoveryAttemptId: "attempt-1",
      serverEpoch: "epoch-1",
      baselineSequence: 5,
      dispatchFrame: vi.fn(),
      onExit: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(subscribe).toHaveBeenCalledWith({
      recoveryAttemptId: "attempt-1",
      serverEpoch: "epoch-1",
      baselineSequence: 5,
    });
    await client.dispose();
  });
});

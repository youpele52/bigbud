import { describe, expect, it, vi } from "vitest";

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
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { SelfHealingStream } from "./selfHealingStream";

const restartImmediately = (restart: () => void) => {
  restart();
};

describe("SelfHealingStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restarts after an unexpected exit while still active", () => {
    const exits: Array<() => void> = [];
    const cancels = vi.fn();
    const stream = new SelfHealingStream(
      ({ onExit }) => {
        exits.push(onExit);
        return () => {
          cancels();
        };
      },
      { scheduleRestart: restartImmediately },
    );

    stream.start();
    expect(exits).toHaveLength(1);

    exits[0]?.();

    expect(exits).toHaveLength(2);
    expect(cancels).not.toHaveBeenCalled();
  });

  it("does not restart after stop", () => {
    const exits: Array<() => void> = [];
    const cancels = vi.fn();
    const scheduleRestart = vi.fn(restartImmediately);
    const stream = new SelfHealingStream(
      ({ onExit }) => {
        exits.push(onExit);
        return () => {
          cancels();
        };
      },
      { scheduleRestart },
    );

    stream.start();
    stream.stop();
    exits[0]?.();

    expect(exits).toHaveLength(1);
    expect(cancels).toHaveBeenCalledOnce();
    expect(scheduleRestart).not.toHaveBeenCalled();
  });

  it("ignores stale exits from an older run", () => {
    const exits: Array<() => void> = [];
    const stream = new SelfHealingStream(
      ({ onExit }) => {
        exits.push(onExit);
        return () => undefined;
      },
      {
        scheduleRestart: (restart) => {
          restart();
        },
      },
    );

    stream.start();
    exits[0]?.();
    expect(exits).toHaveLength(2);

    exits[0]?.();

    expect(exits).toHaveLength(2);
  });

  it("uses cancellable bounded backoff and stops scheduling after disposal", async () => {
    vi.useFakeTimers();
    const exits: Array<() => void> = [];
    const stream = new SelfHealingStream(({ onExit }) => {
      exits.push(onExit);
      return () => undefined;
    });

    stream.start();
    exits[0]?.();
    await vi.advanceTimersByTimeAsync(499);
    expect(exits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toHaveLength(2);

    stream.stop();
    exits[1]?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exits).toHaveLength(2);
  });

  it("stops a repeated stream failure at the bounded restart limit", async () => {
    vi.useFakeTimers();
    const exits: Array<() => void> = [];
    const exhausted = vi.fn();
    const stream = new SelfHealingStream(
      ({ onExit }) => {
        exits.push(onExit);
        return () => undefined;
      },
      { maxRestarts: 2, onExhausted: exhausted },
    );

    stream.start();
    exits[0]?.();
    await vi.advanceTimersByTimeAsync(500);
    exits[1]?.();
    await vi.advanceTimersByTimeAsync(1_000);
    exits[2]?.();

    expect(exhausted).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exits).toHaveLength(3);
  });
});

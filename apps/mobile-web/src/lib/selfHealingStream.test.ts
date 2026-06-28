import { describe, expect, it, vi } from "vitest";

import { SelfHealingStream } from "./selfHealingStream";

const restartImmediately = (restart: () => void) => {
  restart();
};

describe("SelfHealingStream", () => {
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
});

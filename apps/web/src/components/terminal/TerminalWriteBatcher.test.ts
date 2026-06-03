import { describe, expect, it, vi, afterEach } from "vitest";

import { TerminalWriteBatcher } from "./TerminalWriteBatcher";

describe("TerminalWriteBatcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps only one xterm write in flight while coalescing pending output", () => {
    const callbacks: Array<() => void> = [];
    const terminal = {
      write: vi.fn((_data: string, callback?: () => void) => {
        if (callback) {
          callbacks.push(callback);
        }
      }),
    };
    const batcher = new TerminalWriteBatcher();

    batcher.write(terminal as never, "hello");
    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.write).toHaveBeenNthCalledWith(1, "hello", expect.any(Function));

    batcher.write(terminal as never, " ");
    batcher.write(terminal as never, "world");
    expect(terminal.write).toHaveBeenCalledTimes(1);

    callbacks.shift()?.();

    expect(terminal.write).toHaveBeenCalledTimes(2);
    expect(terminal.write).toHaveBeenNthCalledWith(2, " world", expect.any(Function));
  });

  it("flushes pending data immediately", () => {
    const terminal = {
      write: vi.fn(),
    };
    const batcher = new TerminalWriteBatcher();

    batcher.write(terminal as never, "alpha");
    terminal.write.mockClear();
    batcher.write(terminal as never, "beta");
    batcher.write(terminal as never, "gamma");
    batcher.flush();

    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.write).toHaveBeenCalledWith("betagamma");
  });

  it("drops pending writes after dispose even if a prior write callback resolves", () => {
    const callbacks: Array<() => void> = [];
    const terminal = {
      write: vi.fn((_data: string, callback?: () => void) => {
        if (callback) {
          callbacks.push(callback);
        }
      }),
    };
    const batcher = new TerminalWriteBatcher();

    batcher.write(terminal as never, "alpha");
    batcher.write(terminal as never, "beta");
    batcher.dispose();
    callbacks.shift()?.();

    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.write).toHaveBeenNthCalledWith(1, "alpha", expect.any(Function));
  });
});

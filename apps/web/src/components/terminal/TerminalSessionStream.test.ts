import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEvent } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalSessionStreamItem } from "@bigbud/contracts/workspace/terminal.stream.ts";
import {
  TERMINAL_OUTPUT_ACK_DELAY_MS,
  TERMINAL_OUTPUT_ACK_THRESHOLD_CHARS,
  TERMINAL_SESSION_READY_TIMEOUT_MS,
  TerminalSessionStream,
} from "./TerminalSessionStream";

const output = (data: string): TerminalEvent => ({
  type: "output",
  threadId: "thread",
  terminalId: "terminal",
  createdAt: "2026-10-21",
  data,
});

const ignore = (_item: TerminalSessionStreamItem) => undefined;

function fixture(options: { ackFails?: boolean } = {}) {
  let push: (item: TerminalSessionStreamItem) => void = ignore;
  const unsubscribe = vi.fn();
  let outstanding = 0;
  const ackOutput = vi.fn(() =>
    options.ackFails ? Promise.reject(new Error("offline")) : Promise.resolve(),
  );
  const handlers = { deliver: vi.fn(), outstanding: () => outstanding, resync: vi.fn() };
  const stream = new TerminalSessionStream(
    {
      subscribeSession: (_input, listener) => {
        push = listener;
        return unsubscribe;
      },
      ackOutput,
    },
    { threadId: "thread", terminalId: "terminal" },
    handlers,
  );
  return {
    stream,
    handlers,
    ackOutput,
    unsubscribe,
    push: (item: TerminalSessionStreamItem) => push(item),
    setOutstanding: (value: number) => (outstanding = value),
  };
}

describe("TerminalSessionStream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("becomes ready on subscription, or after a bounded wait", async () => {
    const { stream, push } = fixture();
    const ready = vi.fn();
    void stream.ready.then(ready);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    push({ type: "subscribed", subscriptionId: "s1" });
    await Promise.resolve();
    expect(ready).toHaveBeenCalledOnce();

    const late = fixture();
    const lateReady = vi.fn();
    void late.stream.ready.then(lateReady);
    vi.advanceTimersByTime(TERMINAL_SESSION_READY_TIMEOUT_MS);
    await Promise.resolve();
    expect(lateReady).toHaveBeenCalledOnce();
  });

  it("acknowledges only output that is no longer outstanding in the view", () => {
    const { push, ackOutput, setOutstanding, stream } = fixture();
    push({ type: "subscribed", subscriptionId: "s1" });
    setOutstanding(5);
    push(output("hello"));
    vi.advanceTimersByTime(TERMINAL_OUTPUT_ACK_DELAY_MS);
    expect(ackOutput).not.toHaveBeenCalled();
    setOutstanding(0);
    stream.parsed();
    vi.advanceTimersByTime(TERMINAL_OUTPUT_ACK_DELAY_MS);
    expect(ackOutput).toHaveBeenCalledExactlyOnceWith({ subscriptionId: "s1", processedChars: 5 });
  });

  it("acknowledges a large parsed backlog immediately and dropped output too", () => {
    const { push, ackOutput } = fixture();
    push({ type: "subscribed", subscriptionId: "s1" });
    push(output("x".repeat(TERMINAL_OUTPUT_ACK_THRESHOLD_CHARS)));
    expect(ackOutput).toHaveBeenCalledExactlyOnceWith({
      subscriptionId: "s1",
      processedChars: TERMINAL_OUTPUT_ACK_THRESHOLD_CHARS,
    });
  });

  it("retries a failed acknowledgement", async () => {
    const { push, ackOutput } = fixture({ ackFails: true });
    push({ type: "subscribed", subscriptionId: "s1" });
    push(output("abc"));
    vi.advanceTimersByTime(TERMINAL_OUTPUT_ACK_DELAY_MS);
    expect(ackOutput).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(TERMINAL_OUTPUT_ACK_DELAY_MS);
    expect(ackOutput).toHaveBeenCalledTimes(2);
    expect(ackOutput).toHaveBeenLastCalledWith({ subscriptionId: "s1", processedChars: 3 });
  });

  it("asks views to resynchronize on a new subscription and resets credit", () => {
    const { push, handlers, ackOutput } = fixture();
    push({ type: "subscribed", subscriptionId: "s1" });
    expect(handlers.resync).not.toHaveBeenCalled();
    push(output("abc"));
    push({ type: "subscribed", subscriptionId: "s2" });
    expect(handlers.resync).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(TERMINAL_OUTPUT_ACK_DELAY_MS);
    expect(ackOutput).not.toHaveBeenCalled();
  });

  it("stops delivering and acknowledging after close", () => {
    const { push, stream, unsubscribe, handlers, ackOutput } = fixture();
    push({ type: "subscribed", subscriptionId: "s1" });
    stream.close();
    push(output("late"));
    vi.runAllTimers();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(handlers.deliver).not.toHaveBeenCalled();
    expect(ackOutput).not.toHaveBeenCalled();
  });
});

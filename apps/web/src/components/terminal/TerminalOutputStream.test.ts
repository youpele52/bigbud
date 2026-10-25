import { afterEach, expect, it, vi } from "vitest";
import type { TerminalEvent } from "@bigbud/contracts/workspace/terminal.ts";
import {
  publishTerminalOutput,
  setTerminalSessionStreamFactory,
  subscribeTerminalOutput,
} from "./TerminalOutputStream";
import type { TerminalSessionStream, TerminalSessionStreamHandlers } from "./TerminalSessionStream";

const output = (data: string): TerminalEvent => ({
  type: "output",
  threadId: "thread",
  terminalId: "terminal",
  createdAt: "2026-10-10",
  data,
});

afterEach(() => setTerminalSessionStreamFactory(null));

it.each([201, 1000])(
  "delivers all %i entries synchronously before UI batching can evict any",
  (count) => {
    const onEvent = vi.fn();
    const subscription = subscribeTerminalOutput("thread", "terminal", { onEvent });
    try {
      for (let i = 0; i < count; i++) publishTerminalOutput(output(String(i)));
      expect(onEvent).toHaveBeenCalledTimes(count);
      expect(onEvent.mock.calls.map(([event]) => event.data)).toEqual(
        Array.from({ length: count }, (_, i) => String(i)),
      );
    } finally {
      subscription.unsubscribe();
    }
    publishTerminalOutput(output("disposed"));
    expect(onEvent).toHaveBeenCalledTimes(count);
  },
);

it("shares one scoped stream per terminal, credits the slowest view and closes with the last", () => {
  let handlers: TerminalSessionStreamHandlers | null = null;
  const stream = { ready: Promise.resolve(), parsed: vi.fn(), close: vi.fn(), diagnostics: null };
  const factory = vi.fn(
    (_thread: string, _terminal: string, next: TerminalSessionStreamHandlers) => {
      handlers = next;
      return stream as unknown as TerminalSessionStream;
    },
  );
  setTerminalSessionStreamFactory(factory);
  const first = { onEvent: vi.fn(), outstanding: () => 10, onResync: vi.fn() };
  const second = { onEvent: vi.fn(), outstanding: () => 40, onResync: vi.fn() };
  const a = subscribeTerminalOutput("thread", "terminal", first);
  const b = subscribeTerminalOutput("thread", "terminal", second);
  expect(factory).toHaveBeenCalledOnce();

  handlers!.deliver(output("x"));
  expect(first.onEvent).toHaveBeenCalledOnce();
  expect(second.onEvent).toHaveBeenCalledOnce();
  expect(handlers!.outstanding()).toBe(40);
  handlers!.resync();
  expect(first.onResync).toHaveBeenCalledOnce();
  expect(second.onResync).toHaveBeenCalledOnce();

  b.parsed();
  expect(stream.parsed).toHaveBeenCalledOnce();
  b.unsubscribe();
  b.parsed();
  expect(stream.parsed).toHaveBeenCalledOnce();
  expect(stream.close).not.toHaveBeenCalled();
  a.unsubscribe();
  expect(stream.close).toHaveBeenCalledOnce();
});

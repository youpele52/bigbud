import { expect, it, vi } from "vitest";
import { publishTerminalOutput, subscribeTerminalOutput } from "./TerminalOutputStream";

it.each([201, 1000])(
  "delivers all %i entries synchronously before UI batching can evict any",
  (count) => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalOutput("thread", "terminal", listener);
    try {
      for (let i = 0; i < count; i++)
        publishTerminalOutput({
          type: "output",
          threadId: "thread",
          terminalId: "terminal",
          createdAt: "2026-10-10",
          data: String(i),
        });
      expect(listener).toHaveBeenCalledTimes(count);
      expect(listener.mock.calls.map(([event]) => event.data)).toEqual(
        Array.from({ length: count }, (_, i) => String(i)),
      );
    } finally {
      unsubscribe();
    }
    publishTerminalOutput({
      type: "output",
      threadId: "thread",
      terminalId: "terminal",
      createdAt: "2026-10-10",
      data: "disposed",
    });
    expect(listener).toHaveBeenCalledTimes(count);
  },
);

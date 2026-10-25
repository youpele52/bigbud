import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type TerminalEvent, WS_METHODS } from "@bigbud/contracts";
import type { TerminalSessionStreamItem } from "@bigbud/contracts/workspace/terminal.stream.ts";

import { TERMINAL_OUTPUT_DELIVERY_LIMITS } from "../terminal/TerminalOutputDelivery";
import type { WsRpcContext } from "./wsRpcContext";
import { makeWsRpcTerminalSessionHandlers } from "./wsRpcHandlers.terminalSession";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const output = (terminalId: string, data: string): TerminalEvent => ({
  type: "output",
  threadId: "thread",
  terminalId,
  createdAt: "2026-10-21T00:00:00.000Z",
  data,
});

function fixture() {
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const subscribeOptions: unknown[] = [];
  const setOutputHold = vi.fn((_input: { held: boolean }) => Effect.succeed(true));
  const terminalManager = {
    subscribe: (listener: (event: TerminalEvent) => Effect.Effect<void>, options?: unknown) =>
      Effect.sync(() => {
        listeners.add(listener);
        subscribeOptions.push(options);
        return () => listeners.delete(listener);
      }),
    setOutputHold,
  };
  const handlers = makeWsRpcTerminalSessionHandlers({ terminalManager } as unknown as WsRpcContext);
  const publish = (event: TerminalEvent) =>
    Effect.runPromise(Effect.forEach([...listeners], (listener) => listener(event)));
  return { handlers, listeners, publish, setOutputHold, subscribeOptions };
}

describe("terminal session stream handlers", () => {
  it("scopes output to one terminal and sends no more than the parse-credit window", async () => {
    const { handlers, listeners, publish, setOutputHold } = fixture();
    const items: TerminalSessionStreamItem[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(
        handlers[WS_METHODS.subscribeTerminalSession]({ threadId: "thread", terminalId: "a" }),
        (item) => Effect.sync(() => items.push(item)),
      ),
    );
    await tick();
    expect(items[0]).toMatchObject({ type: "subscribed" });
    const subscriptionId = (items[0] as { subscriptionId: string }).subscriptionId;
    const window = TERMINAL_OUTPUT_DELIVERY_LIMITS.creditWindow;
    const sent = () =>
      items.reduce((total, item) => total + (item.type === "output" ? item.data.length : 0), 0);

    await publish(output("other", "ignored"));
    await publish(output("a", "x".repeat(window + 1000)));
    await tick();
    expect(sent()).toBe(window);
    await Effect.runPromise(
      handlers[WS_METHODS.terminalOutputAck]({ subscriptionId, processedChars: window }),
    );
    await tick();
    expect(sent()).toBe(window + 1000);

    await publish(output("a", "y".repeat(TERMINAL_OUTPUT_DELIVERY_LIMITS.holdHighWater * 2)));
    await tick();
    expect(setOutputHold).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "thread", terminalId: "a", held: true }),
    );

    await Effect.runPromise(Fiber.interrupt(fiber));
    await tick();
    expect(listeners.size).toBe(0);
    expect(setOutputHold).toHaveBeenLastCalledWith(expect.objectContaining({ held: false }));
    // Acknowledgements for ended subscriptions are ignored.
    await Effect.runPromise(
      handlers[WS_METHODS.terminalOutputAck]({ subscriptionId, processedChars: 1 }),
    );
  });

  it("passes the legacy-detection output scope to the global subscription", async () => {
    const { handlers, subscribeOptions } = fixture();
    const fiber = Effect.runFork(
      Stream.runDrain(
        handlers[WS_METHODS.subscribeTerminalEvents]({ outputScope: "legacyDetection" }),
      ),
    );
    await tick();
    expect(subscribeOptions).toEqual([{ outputScope: "legacyDetection" }]);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  it("delegates search to the manager and returns no hits when it cannot search", async () => {
    const hits = [
      {
        threadId: "thread",
        terminalId: "a",
        lineText: "found it",
        matchStart: 0,
        linesFromEnd: 0,
        running: true,
      },
    ];
    const search = vi.fn(() => Effect.succeed({ hits, truncated: false }));
    const handlers = makeWsRpcTerminalSessionHandlers({
      terminalManager: { search },
    } as unknown as WsRpcContext);
    const result = await Effect.runPromise(
      handlers[WS_METHODS.terminalSearch]({ query: "found" }) as Effect.Effect<unknown>,
    );
    expect(search).toHaveBeenCalledWith({ query: "found" });
    expect(result).toEqual({ hits, truncated: false });
    const legacy = makeWsRpcTerminalSessionHandlers({
      terminalManager: {},
    } as unknown as WsRpcContext);
    expect(
      await Effect.runPromise(
        legacy[WS_METHODS.terminalSearch]({ query: "found" }) as Effect.Effect<unknown>,
      ),
    ).toEqual({ hits: [], truncated: false });
  });
});

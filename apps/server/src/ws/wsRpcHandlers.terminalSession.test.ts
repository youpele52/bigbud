import { Deferred, Effect, Fiber, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type TerminalEvent, WS_METHODS } from "@bigbud/contracts";
import type {
  TerminalEventsStreamItem,
  TerminalSessionStreamItem,
} from "@bigbud/contracts/workspace/terminal.stream.ts";

import { TERMINAL_OUTPUT_DELIVERY_LIMITS } from "../terminal/TerminalOutputDelivery";
import type { WsRpcContext } from "./wsRpcContext";
import type { TerminalSubscribeOptions } from "../terminal/Services/Manager";
import { makeWsRpcTerminalSessionHandlers } from "./wsRpcHandlers.terminalSession";
import { TERMINAL_EVENTS_OUTPUT_BACKLOG_LIMITS } from "./wsRpcHandlers.terminalEvents";

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

  it("opts into inventory control items through the same bounded global queue", async () => {
    const inventory = {
      type: "inventory" as const,
      createdAt: "2026-10-29T00:00:00Z",
      sessions: [],
    };
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((_listener: unknown, options?: TerminalSubscribeOptions) =>
      Effect.gen(function* () {
        yield* options!.onInventory!(inventory);
        return unsubscribe;
      }),
    );
    const handlers = makeWsRpcTerminalSessionHandlers({
      terminalManager: { subscribe },
    } as unknown as WsRpcContext);
    const items = await Effect.runPromise(
      Stream.runCollect(
        Stream.take(
          handlers[WS_METHODS.subscribeTerminalEvents]({
            outputScope: "legacyDetection",
            includeInventory: true,
          }),
          1,
        ),
      ),
    );
    expect([...items]).toEqual([inventory]);
    expect(subscribe).toHaveBeenCalledWith(expect.any(Function), {
      outputScope: "legacyDetection",
      onInventory: expect.any(Function),
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("ends a stalled global subscriber at the hard cap without affecting a fast subscriber", async () => {
    const { handlers, listeners, publish } = fixture();
    const gate = Deferred.makeUnsafe<void>();
    const slowEvents: TerminalEventsStreamItem[] = [];
    const fastEvents: TerminalEventsStreamItem[] = [];
    const stream = () =>
      handlers[WS_METHODS.subscribeTerminalEvents]({ outputScope: "legacyDetection" });
    const slow = Effect.runFork(
      Stream.runForEach(stream(), (event) =>
        Effect.gen(function* () {
          slowEvents.push(event);
          yield* Deferred.await(gate);
        }),
      ),
    );
    const fast = Effect.runFork(
      Stream.runForEach(stream(), (event) =>
        Effect.sync(() => {
          fastEvents.push(event);
        }),
      ),
    );
    const event: TerminalEvent = {
      type: "exited",
      threadId: "thread",
      terminalId: "a",
      createdAt: "2026-10-29T00:00:00Z",
      exitCode: 0,
      exitSignal: null,
    };
    let replacement: ReturnType<typeof Effect.runFork> | undefined;
    try {
      await tick();
      await publish(event);
      await tick();
      expect(slowEvents).toHaveLength(1);
      const count = TERMINAL_EVENTS_OUTPUT_BACKLOG_LIMITS.totalItems + 1;
      for (let index = 0; index < count; index++) {
        await publish(event);
        if (index % 64 === 0) await tick();
      }
      await Effect.runPromise(Deferred.succeed(gate, undefined));
      await Effect.runPromise(Fiber.join(slow));
      await tick();
      expect(slowEvents).toHaveLength(1);
      expect(fastEvents).toHaveLength(count + 1);
      expect(listeners.size).toBe(1);
      replacement = Effect.runFork(
        Stream.runForEach(stream(), (item) =>
          Effect.sync(() => {
            slowEvents.push(item);
          }),
        ),
      );
      await tick();
      await publish(event);
      await tick();
      expect(slowEvents).toHaveLength(2);
    } finally {
      if (replacement) await Effect.runPromise(Fiber.interrupt(replacement));
      await Effect.runPromise(Fiber.interrupt(slow));
      await Effect.runPromise(Fiber.interrupt(fast));
    }
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

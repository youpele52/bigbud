import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type TerminalEvent, WS_METHODS } from "@bigbud/contracts";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import type {
  TerminalEventsStreamItem,
  TerminalScreenItem,
  TerminalSessionStreamRpcItem,
} from "@bigbud/contracts/workspace/terminal.stream.ts";

import type { TerminalSessionStreamSink } from "../terminal/Services/Manager";
import type { WsRpcContext } from "./wsRpcContext";
import { makeWsRpcTerminalSessionHandlers } from "./wsRpcHandlers.terminalSession";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const createdAt = "2026-11-21T00:00:00.000Z";
const screen: TerminalScreenItem = {
  type: "screen",
  threadId: "thread",
  terminalId: "a",
  runtimeGeneration: "g",
  throughSequence: "7",
  cols: 80,
  rows: 24,
  ansi: "restored",
  pendingEscapeTail: "",
  scrollbackRows: 0,
  alternateScreen: false,
  fidelity: "full",
  cold: false,
};
const output = (data: string): TerminalEvent => ({
  type: "output",
  threadId: "thread",
  terminalId: "a",
  createdAt,
  data,
});

describe("host session streams", () => {
  it("sends subscribed, then the screen, then live events, and reports the parsed chars", async () => {
    let sink: TerminalSessionStreamSink | undefined;
    const unsubscribe = vi.fn();
    const subscribeSession = vi.fn((_input: unknown, given: TerminalSessionStreamSink) =>
      Effect.sync(() => {
        sink = given;
        return {
          start: () => {
            given.screen(screen);
            given.event(output("live"));
          },
          unsubscribe,
        };
      }),
    );
    const handlers = makeWsRpcTerminalSessionHandlers({
      terminalManager: { subscribeSession, subscribe: () => Effect.die("unused") },
    } as unknown as WsRpcContext);
    const items: TerminalSessionStreamRpcItem[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(
        handlers[WS_METHODS.subscribeTerminalSession]({
          threadId: "thread",
          terminalId: "a",
          acceptScreen: true,
        }),
        (item) => Effect.sync(() => items.push(item)),
      ),
    );
    await tick();
    expect(subscribeSession).toHaveBeenCalledWith(
      { threadId: "thread", terminalId: "a", acceptScreen: true },
      expect.anything(),
    );
    expect(items.map((item) => item.type)).toEqual(["subscribed", "screen", "output"]);
    const subscriptionId = (items[0] as { subscriptionId: string }).subscriptionId;
    await Effect.runPromise(
      handlers[WS_METHODS.terminalOutputAck]({ subscriptionId, processedChars: 4 }),
    );
    sink?.event(output("more"));
    await tick();
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(unsubscribe).toHaveBeenCalledWith(4);
  });

  it("asks for no screen unless the subscriber accepts one", async () => {
    const subscribeSession = vi.fn(() =>
      Effect.succeed({ start: () => undefined, unsubscribe: () => undefined }),
    );
    const handlers = makeWsRpcTerminalSessionHandlers({
      terminalManager: { subscribeSession },
    } as unknown as WsRpcContext);
    const fiber = Effect.runFork(
      Stream.runDrain(
        handlers[WS_METHODS.subscribeTerminalSession]({ threadId: "thread", terminalId: "a" }),
      ),
    );
    await tick();
    expect(subscribeSession).toHaveBeenCalledWith(
      { threadId: "thread", terminalId: "a", acceptScreen: false },
      expect.anything(),
    );
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  it("delivers lifecycle notices only to subscribers that opt in", async () => {
    const notice: TerminalLifecycleNotice = {
      type: "lifecycleNotice",
      noticeId: "n-1",
      kind: "idleClosed",
      threadId: "thread",
      terminalId: "a",
      createdAt,
    };
    const subscribeLifecycle = vi.fn(
      (listener: (notice: TerminalLifecycleNotice) => Effect.Effect<void>) =>
        Effect.as(listener(notice), () => undefined),
    );
    const handlers = makeWsRpcTerminalSessionHandlers({
      terminalManager: { subscribeLifecycle, subscribe: () => Effect.succeed(() => undefined) },
    } as unknown as WsRpcContext);
    const items = await Effect.runPromise(
      Stream.runCollect(
        Stream.take(handlers[WS_METHODS.subscribeTerminalEvents]({ includeLifecycle: true }), 1),
      ),
    );
    expect([...items] as TerminalEventsStreamItem[]).toEqual([notice]);
    const plain = Effect.runFork(Stream.runDrain(handlers[WS_METHODS.subscribeTerminalEvents]({})));
    await tick();
    expect(subscribeLifecycle).toHaveBeenCalledOnce();
    await Effect.runPromise(Fiber.interrupt(plain));
  });
});

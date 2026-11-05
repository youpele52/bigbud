import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import type { MuseBridgeHandle } from "./Adapter.types.ts";
import type { MuseTransport } from "./Client.ts";
import {
  deferred,
  makeMuseTestHost,
  startInput,
  threadId,
} from "./Adapter.failures.test.helpers.ts";

describe("Muse startup and host ownership", () => {
  it("removes only failed owned state when buffered callback overflow fails after registration", async () => {
    const host = makeMuseTestHost();
    const original = host.transport.command;
    host.transport.command = async (method, params, cid) => {
      const raw = await original(method, params, cid);
      if (method === "session/start")
        for (let i = 0; i < 129; i++)
          host.emit({ method: "turn/started", params: { turnId: `turn-${i}` } });
      return raw;
    };
    const adapter = await Effect.runPromise(host.adapter());
    const result = await Effect.runPromise(adapter.startSession(startInput).pipe(Effect.result));
    expect(result._tag).toBe("Failure");
    expect(await Effect.runPromise(adapter.hasSession(threadId))).toBe(false);
    expect(host.closed()).toBe(1);
  });
  it("closes a host that resolves after startup interruption, even when its factory ignores abort", async () => {
    const host = makeMuseTestHost();
    const entered = deferred<void>();
    const pending = deferred<MuseTransport>();
    const closed = deferred<void>();
    host.transport.close = async () => {
      closed.resolve();
    };
    const adapter = await Effect.runPromise(
      host.adapter({
        hostFactory: async () => {
          entered.resolve();
          return pending.promise;
        },
      }),
    );
    const startup = Effect.runFork(adapter.startSession(startInput));
    await entered.promise;
    await Effect.runPromise(Fiber.interrupt(startup));
    pending.resolve(host.transport);
    await closed.promise;
    expect(await Effect.runPromise(adapter.hasSession(threadId))).toBe(false);
  });
  it("owns and closes late bridge acquisition after interruption and closes the host promptly", async () => {
    const host = makeMuseTestHost();
    const entered = deferred<void>();
    const pending = deferred<MuseBridgeHandle>();
    const cleaned = deferred<void>();
    const adapter = await Effect.runPromise(
      host.adapter({
        bridgeFactory: () =>
          Effect.promise(async () => {
            entered.resolve();
            return pending.promise;
          }),
      }),
    );
    const startup = Effect.runFork(adapter.startSession(startInput));
    await entered.promise;
    await Effect.runPromise(Fiber.interrupt(startup));
    expect(host.closed()).toBe(1);
    pending.resolve({
      config: {},
      cleanup: async () => {
        cleaned.resolve();
      },
    });
    await cleaned.promise;
    expect(await Effect.runPromise(adapter.hasSession(threadId))).toBe(false);
  });
  it("attempts host cleanup when bridge cleanup throws synchronously", async () => {
    const host = makeMuseTestHost();
    const original = host.transport.command;
    host.transport.command = async (method, params, cid) => {
      if (method === "session/start") throw "uncertain";
      return original(method, params, cid);
    };
    let cleaned = 0;
    const adapter = await Effect.runPromise(
      host.adapter({
        bridgeFactory: () =>
          Effect.succeed({
            config: {},
            cleanup: () => {
              cleaned++;
              throw new Error("cleanup failed");
            },
          }),
      }),
    );
    expect((await Effect.runPromise(Effect.result(adapter.startSession(startInput))))._tag).toBe(
      "Failure",
    );
    expect(cleaned).toBe(1);
    expect(host.closed()).toBe(1);
    expect(await Effect.runPromise(adapter.hasSession(threadId))).toBe(false);
  });
  it("retains successful resources until stop, and stop attempts both cleanups", async () => {
    const host = makeMuseTestHost();
    let cleaned = 0;
    const adapter = await Effect.runPromise(
      host.adapter({
        bridgeFactory: () =>
          Effect.succeed({
            config: {},
            cleanup: async () => {
              cleaned++;
              throw new Error("bad cleanup");
            },
          }),
      }),
    );
    await Effect.runPromise(adapter.startSession(startInput));
    expect(cleaned).toBe(0);
    expect(host.closed()).toBe(0);
    await Effect.runPromise(adapter.stopSession(threadId));
    expect(cleaned).toBe(1);
    expect(host.closed()).toBe(1);
    host.emit({ method: "turn/started", params: { turnId: "late" } });
    expect(await Effect.runPromise(adapter.hasSession(threadId))).toBe(false);
  });
  it("unexpected host loss fences callbacks and emits one epoch-stamped recoverable exit", async () => {
    const host = makeMuseTestHost();
    const events: Array<ProviderRuntimeEvent> = [];
    const exit = deferred<void>();
    const adapter = await Effect.runPromise(host.adapter());
    const subscriber = Effect.runFork(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
          if (event.type === "session.exited") exit.resolve();
        }),
      ),
    );
    await Effect.runPromise(Effect.sleep(5));
    await Effect.runPromise(adapter.startSession({ ...startInput, sessionEpoch: 7 }));
    host.options()!.onExit!(new Error("host died"));
    host.options()!.onExit!(new Error("duplicate closed"));
    await exit.promise;
    host.emit({ method: "turn/completed", params: { turnId: "late", terminal: "completed" } });
    expect(await Effect.runPromise(adapter.hasSession(threadId))).toBe(false);
    expect(events.filter((event) => event.type === "session.exited")).toMatchObject([
      { sessionEpoch: 7, payload: { recoverable: true } },
    ]);
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    await Effect.runPromise(Fiber.interrupt(subscriber));
  });
});

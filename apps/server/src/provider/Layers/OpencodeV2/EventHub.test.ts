import { describe, expect, it, vi } from "vitest";

import { OpencodeV2EventHub } from "./EventHub.ts";
import { FixtureEvents, fixtureEvent, flushMicrotasks, deferred } from "./Test.fixtures.ts";

const makeHub = (source: FixtureEvents, maxQueuedEvents = 4) =>
  new OpencodeV2EventHub({
    maxOwners: 32,
    subscribe: (signal) => source.subscribe(signal),
    maxQueuedEvents,
    maxEventBytes: 1024,
    consumerTimeoutMs: 100,
  });

describe("OpenCode v2 process event hub", () => {
  it("uses one source and never routes unowned/cross-Location events", async () => {
    const source = new FixtureEvents();
    const hub = makeHub(source);
    const events = vi.fn(async () => {});
    const dirty = vi.fn();
    hub.register({ nativeSessionId: "ses_one", location: "/one", onEvent: events, onDirty: dirty });
    hub.start();
    hub.start();
    source.push(fixtureEvent("ses_unknown"));
    source.push(fixtureEvent());
    await flushMicrotasks();
    expect(events).toHaveBeenCalledTimes(1);
    source.push(fixtureEvent("ses_one", "/hostile"));
    source.push(fixtureEvent());
    await flushMicrotasks();
    expect(events).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenCalledWith("ambiguous");
    expect(hub.reconciled("ses_one")).toBe(true);
    source.push(fixtureEvent());
    await flushMicrotasks();
    expect(events).toHaveBeenCalledTimes(2);
    expect(source.subscriptions).toBe(1);
    await hub.close();
  });

  it("isolates slow owners, marks overflow dirty, and aborts in-flight delivery", async () => {
    const source = new FixtureEvents();
    const hub = makeHub(source, 1);
    const hold = deferred<void>();
    let delivery: AbortSignal | undefined;
    const dirty = vi.fn();
    const fast = vi.fn(async () => {});
    hub.register({
      nativeSessionId: "ses_one",
      location: "/one",
      onDirty: dirty,
      onEvent: async (_event, signal) => {
        delivery = signal;
        await hold.promise;
      },
    });
    hub.register({ nativeSessionId: "ses_two", location: "/two", onDirty: vi.fn(), onEvent: fast });
    hub.start();
    source.push(fixtureEvent());
    await flushMicrotasks();
    source.push(fixtureEvent("ses_one", "/one", "queued"));
    source.push(fixtureEvent("ses_one", "/one", "overflow"));
    source.push(fixtureEvent("ses_two", "/two"));
    await flushMicrotasks();
    expect(dirty).toHaveBeenCalledWith("overflow");
    expect(delivery?.aborted).toBe(true);
    expect(fast).toHaveBeenCalledTimes(1);
    hold.resolve();
    await hub.close();
  });

  it("source loss marks all owners dirty without claiming terminal completion", async () => {
    const dirty = vi.fn();
    const hub = new OpencodeV2EventHub({
      maxOwners: 32,
      subscribe: async function* () {
        yield await Promise.reject(new Error("gap"));
      },
      maxQueuedEvents: 1,
      maxEventBytes: 1024,
      consumerTimeoutMs: 50,
    });
    hub.register({
      nativeSessionId: "ses_one",
      location: "/one",
      onEvent: vi.fn(),
      onDirty: dirty,
    });
    hub.start();
    await flushMicrotasks();
    expect(dirty).toHaveBeenCalledWith("gap");
    await hub.close();
  });

  it("bounds cleanup even when the source ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const hub = new OpencodeV2EventHub({
        maxOwners: 32,
        subscribe: async function* () {
          yield await new Promise<ReturnType<typeof fixtureEvent>>(() => {});
        },
        maxQueuedEvents: 1,
        maxEventBytes: 1024,
        consumerTimeoutMs: 50,
      });
      hub.start();
      const closed = hub.close();
      await vi.advanceTimersByTimeAsync(1000);
      await closed;
    } finally {
      vi.useRealTimers();
    }
  });
});

import { expect, it } from "vitest";
import { OpencodeV2EventHub } from "./EventHub.ts";
import { FixtureEvents, deferred, fixtureEvent, flushMicrotasks } from "./Test.fixtures.ts";

it("fences event arrival before a blocked consumer, isolates other sessions, and includes locationless execution starts", async () => {
  const source = new FixtureEvents(),
    release = deferred<void>();
  const hub = new OpencodeV2EventHub({
    subscribe: (signal) => source.subscribe(signal),
    requireMarker: true,
    maxOwners: 2,
    maxQueuedEvents: 8,
    maxEventBytes: 10000,
    consumerTimeoutMs: 10000,
  });
  hub.register({
    nativeSessionId: "ses_one",
    location: "/one",
    onEvent: async () => release.promise,
    onDirty: () => {},
  });
  hub.register({
    nativeSessionId: "ses_other",
    location: "/other",
    onEvent: async () => {},
    onDirty: () => {},
  });
  try {
    expect(hub.captureArrivalFence("ses_one")).toBeUndefined();
    hub.start();
    await expect.poll(() => Boolean(hub.captureArrivalFence("ses_one"))).toBe(true);
    const first = hub.captureArrivalFence("ses_one")!;
    source.push(fixtureEvent("ses_other", "/other"));
    source.push(fixtureEvent("ses_unowned", "/unknown"));
    await flushMicrotasks();
    expect(first).not.toThrow();
    source.push(fixtureEvent());
    await expect
      .poll(() => {
        try {
          first();
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
    const queued = hub.captureArrivalFence("ses_one")!;
    source.push(fixtureEvent("ses_one", "/one", "queued-behind-consumer"));
    await expect
      .poll(() => {
        try {
          queued();
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
    const locationless = hub.captureArrivalFence("ses_one")!;
    source.push({
      id: "start",
      type: "session.execution.started",
      created: 1,
      durable: { aggregateID: "ses_one", seq: 1, version: 1 },
      data: { sessionID: "ses_one" },
    });
    await expect
      .poll(() => {
        try {
          locationless();
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
    expect(hub.generation("ses_one")).toBe(0); // Healthy arrivals do not masquerade as source gaps.
  } finally {
    release.resolve();
    await hub.close();
  }
});

it("requires a connection marker and never carries an arrival fence across a disconnected/reconnected source", async () => {
  const disconnect = deferred<void>(),
    marker = deferred<void>();
  let connections = 0;
  const hub = new OpencodeV2EventHub({
    requireMarker: true,
    maxOwners: 1,
    maxQueuedEvents: 8,
    maxEventBytes: 10000,
    consumerTimeoutMs: 10000,
    subscribe: async function* (signal) {
      const connection = ++connections;
      if (connection === 1) await marker.promise;
      yield { id: `connection-${connection}`, type: "server.connected", data: {} };
      if (connection === 1) await disconnect.promise;
      else
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
    },
  });
  hub.register({
    nativeSessionId: "ses_one",
    location: "/one",
    onEvent: async () => {},
    onDirty: () => {},
  });
  try {
    hub.start();
    expect(hub.captureArrivalFence("ses_one")).toBeUndefined();
    marker.resolve();
    await expect.poll(() => Boolean(hub.captureArrivalFence("ses_one"))).toBe(true);
    const old = hub.captureArrivalFence("ses_one")!;
    disconnect.resolve();
    await expect.poll(() => hub.isDirty("ses_one")).toBe(true);
    expect(old).toThrow();
    await flushMicrotasks();
    expect(hub.captureArrivalFence("ses_one")).toBeUndefined();
    hub.start();
    await expect.poll(() => Boolean(hub.captureArrivalFence("ses_one"))).toBe(true);
    expect(old).toThrow();
    expect(hub.captureArrivalFence("ses_one")!).not.toThrow();
  } finally {
    marker.resolve();
    disconnect.resolve();
    await hub.close();
  }
});

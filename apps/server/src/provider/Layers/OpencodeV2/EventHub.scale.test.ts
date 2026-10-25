import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";

import { OpencodeV2EventHub } from "./EventHub.ts";
import { FixtureEvents, fixtureEvent, flushMicrotasks, deferred } from "./Test.fixtures.ts";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";

it("demultiplexes synthetic bursts across 25 owners without cross-delivery or unbounded ownership", async () => {
  const source = new FixtureEvents();
  const hub = new OpencodeV2EventHub({
    subscribe: (signal) => source.subscribe(signal),
    maxOwners: 25,
    maxQueuedEvents: 16,
    maxEventBytes: 1024,
    consumerTimeoutMs: 1000,
  });
  const counts = Array.from({ length: 25 }, () => 0);
  const complete = deferred<void>();
  let delivered = 0;
  const dirty: string[] = [];
  const unregister = counts.map((_count, index) =>
    hub.register({
      nativeSessionId: `ses_${index}`,
      location: `/fixture/${index}`,
      onDirty: (reason) => {
        dirty.push(reason);
      },
      onEvent: async (event) => {
        expect(event).toMatchObject({
          location: { directory: `/fixture/${index}` },
          data: { sessionID: `ses_${index}` },
        });
        counts[index]!++;
        if (++delivered === 2500) complete.resolve();
      },
    }),
  );
  expect(() =>
    hub.register({
      nativeSessionId: "ses_overflow",
      location: "/fixture",
      onEvent: async () => {},
      onDirty: () => {},
    }),
  ).toThrow();
  const started = performance.now();
  hub.start();
  try {
    for (let wave = 0; wave < 100; wave++) {
      for (let index = 0; index < 25; index++)
        source.push(fixtureEvent(`ses_${index}`, `/fixture/${index}`, `wave-${wave}`));
      await flushMicrotasks();
    }
    await runWithAbortableDeadline({
      operation: "synthetic fixture drain",
      timeoutMs: 5000,
      run: () => complete.promise,
    });
    expect(counts).toEqual(Array.from({ length: 25 }, () => 100));
    expect(dirty).toEqual([]);
    expect(source.subscriptions).toBe(1);
    console.log(
      JSON.stringify({
        scope: "synthetic event hub only; not model generation",
        owners: 25,
        events: 2500,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  } finally {
    for (const release of unregister) release();
    await hub.close();
  }
});

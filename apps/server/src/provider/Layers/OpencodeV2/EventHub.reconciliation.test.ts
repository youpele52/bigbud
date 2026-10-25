import { expect, it } from "vitest";
import { OpencodeV2EventHub } from "./EventHub.ts";
import { FixtureEvents, deferred, fixtureEvent } from "./Test.fixtures.ts";

it("dirty draining repair requests one post-drain caller read, never clears a gap or spins re-entrantly", async () => {
  const source = new FixtureEvents(),
    entered = deferred<void>(),
    release = deferred<void>();
  let retries = 0,
    duringCallback: boolean | undefined,
    generation: number | undefined;
  const hub = new OpencodeV2EventHub({
    subscribe: (signal) => source.subscribe(signal),
    maxOwners: 1,
    maxQueuedEvents: 8,
    maxEventBytes: 10000,
    consumerTimeoutMs: 1000,
  });
  hub.register({
    nativeSessionId: "ses_one",
    location: "/one",
    onDirty: () => {},
    onDrained: () => {
      retries++;
    },
    onEvent: async () => {
      hub.markGap();
      generation = hub.generation("ses_one");
      duringCallback = hub.reconciled("ses_one", generation);
      entered.resolve();
      await release.promise;
    },
  });
  try {
    hub.start();
    source.push(fixtureEvent());
    await entered.promise;
    expect(duringCallback).toBe(false);
    await expect.poll(() => retries).toBe(1);
    const afterDrain = hub.generation("ses_one");
    expect(afterDrain).toBeGreaterThanOrEqual(generation!);
    expect(hub.isDirty("ses_one")).toBe(true);
    expect(hub.reconciled("ses_one", generation)).toBe(false); // Consumer abort superseded this snapshot.
    expect(hub.reconciled("ses_one", afterDrain)).toBe(true);
    expect(hub.isDirty("ses_one")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(retries).toBe(1);
  } finally {
    release.resolve();
    await hub.close();
  }
});

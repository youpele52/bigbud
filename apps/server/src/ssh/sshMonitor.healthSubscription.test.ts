import { describe, expect, it } from "vitest";

import { makeSelectedSshMonitorHealth } from "./sshMonitor.healthOwner.ts";
import { SshOwnerStatusBroker, type SshOwnerStatusEvent } from "./sshMonitor.healthSubscription.ts";

const statuses = (events: readonly SshOwnerStatusEvent[]) =>
  events.flatMap((event) => (event.kind === "status" ? [event.status.sample] : [event.kind]));

describe("bounded owner status fan-out", () => {
  it("delivers the same typed status to independent subscribers", () => {
    const broker = new SshOwnerStatusBroker("ssh:fixture", 3);
    const first = broker.subscribe();
    const second = broker.subscribe();
    broker.publish("reachable");
    expect(first.drain()).toEqual([
      {
        kind: "status",
        status: {
          targetId: "ssh:fixture",
          generation: 3,
          sample: "reachable",
          observedAt: expect.any(Number),
        },
      },
    ]);
    expect(second.drain()).toHaveLength(1);
    first.close();
    second.close();
  });

  it("coalesces a stalled reader into one resync plus the newest status", () => {
    const broker = new SshOwnerStatusBroker("ssh:fixture", 0, 2);
    const stalled = broker.subscribe();
    const active = broker.subscribe();
    broker.publish("reachable");
    expect(statuses(active.drain())).toEqual(["reachable"]);
    // The stalled reader has not drained; later samples must stay bounded.
    broker.publish("unreachable");
    broker.publish("reachable");
    broker.publish("unavailable");
    const backlog = stalled.drain();
    expect(backlog).toHaveLength(2);
    expect(backlog[0]).toEqual({ kind: "resync", reason: "overflow" });
    expect(statuses(backlog)).toEqual(["resync", "unavailable"]);
    // The active reader is unaffected and still receives fresh state.
    expect(statuses(active.drain())).toEqual(["resync", "unavailable"]);
    broker.publish("reachable");
    expect(statuses(active.drain())).toEqual(["reachable"]);
  });

  it("keeps could-not-sample distinct from an observed transport failure", () => {
    const broker = new SshOwnerStatusBroker("ssh:fixture");
    const subscriber = broker.subscribe();
    broker.publish("unavailable");
    broker.publish("unreachable");
    expect(statuses(subscriber.drain())).toEqual(["unavailable", "unreachable"]);
  });

  it("cancels one subscriber without touching the other or the broker", () => {
    const broker = new SshOwnerStatusBroker("ssh:fixture");
    const controller = new AbortController();
    const cancelled = broker.subscribe(controller.signal);
    const remaining = broker.subscribe();
    controller.abort();
    expect(cancelled.closed).toBe(true);
    expect(broker.subscriberCount).toBe(1);
    broker.publish("reachable");
    expect(cancelled.drain()).toEqual([]);
    expect(statuses(remaining.drain())).toEqual(["reachable"]);
  });

  it("turns a generation change into a resync instead of replaying old status", () => {
    const broker = new SshOwnerStatusBroker("ssh:fixture", 1);
    const subscriber = broker.subscribe();
    broker.setGeneration(2);
    broker.publish("reachable", 1);
    const events = subscriber.drain();
    expect(events).toEqual([{ kind: "resync", reason: "generation" }]);
    broker.publish("unreachable", 2);
    expect(statuses(subscriber.drain())).toEqual(["unreachable"]);
  });

  it("closes every subscriber with one final event", () => {
    const broker = new SshOwnerStatusBroker("ssh:fixture");
    const subscriber = broker.subscribe();
    broker.publish("reachable");
    broker.close();
    expect(subscriber.drain()).toEqual([
      {
        kind: "status",
        status: expect.objectContaining({ sample: "reachable" }),
      },
      { kind: "closed" },
    ]);
    expect(broker.subscriberCount).toBe(0);
  });

  it("rejects an unbounded or unsafe queue configuration", () => {
    expect(() => new SshOwnerStatusBroker("", 0)).toThrow();
    expect(() => new SshOwnerStatusBroker("ssh:fixture", 0, 1)).toThrow();
    expect(() => new SshOwnerStatusBroker("ssh:fixture", 0, 1.5)).toThrow();
  });
});

describe("monitor composition", () => {
  it("publishes one sample to both subscribers without resampling", async () => {
    let samples = 0;
    const health = makeSelectedSshMonitorHealth(
      "ssh:fixture",
      "/workspace",
      async (_id, sample) => {
        samples += 1;
        return sample({
          sampleCancellableProofHealth: async () => {
            samples += 1;
            return true;
          },
        });
      },
    );
    const first = health.subscribeStatus();
    const second = health.subscribeStatus();
    await expect(health.sampleHealth("ssh:fixture", new AbortController().signal)).resolves.toBe(
      "reachable",
    );
    expect(samples).toBe(2);
    expect(statuses(first.drain())).toEqual(["reachable"]);
    expect(statuses(second.drain())).toEqual(["reachable"]);
    expect(samples).toBe(2);
    health.setStatusGeneration(4);
    expect(first.drain()).toEqual([{ kind: "resync", reason: "generation" }]);
    health.closeStatus();
    expect(second.drain()).toEqual([{ kind: "resync", reason: "generation" }, { kind: "closed" }]);
  });

  it("does not publish a sample for another target or an aborted caller", async () => {
    const health = makeSelectedSshMonitorHealth("ssh:fixture", "/workspace", async () => true);
    const subscriber = health.subscribeStatus();
    await expect(health.sampleHealth("ssh:other", new AbortController().signal)).resolves.toBe(
      "unavailable",
    );
    const aborted = new AbortController();
    aborted.abort();
    await expect(health.sampleHealth("ssh:fixture", aborted.signal)).resolves.toBe("unavailable");
    expect(subscriber.drain()).toEqual([]);
  });

  it("drops an older in-flight sample that settles after a newer one", async () => {
    const pending: Array<{ resolve: (value: boolean) => void }> = [];
    const health = makeSelectedSshMonitorHealth(
      "ssh:fixture",
      "/workspace",
      async () => new Promise<boolean>((resolve) => pending.push({ resolve })),
    );
    const subscriber = health.subscribeStatus();
    const older = health.sampleHealth("ssh:fixture", new AbortController().signal);
    const newer = health.sampleHealth("ssh:fixture", new AbortController().signal);
    pending[1]?.resolve(true);
    await expect(newer).resolves.toBe("reachable");
    pending[0]?.resolve(false);
    await expect(older).resolves.toBe("unreachable");
    expect(statuses(subscriber.drain())).toEqual(["reachable"]);
  });

  it("does not publish a sample when the probe signal aborts", async () => {
    const pending: Array<{ resolve: (value: boolean) => void }> = [];
    const health = makeSelectedSshMonitorHealth(
      "ssh:fixture",
      "/workspace",
      async () => new Promise<boolean>((resolve) => pending.push({ resolve })),
    );
    const subscriber = health.subscribeStatus();
    const controller = new AbortController();
    const sample = health.sampleHealth("ssh:fixture", controller.signal);
    controller.abort();
    pending[0]?.resolve(true);
    await expect(sample).resolves.toBe("unavailable");
    expect(subscriber.drain()).toEqual([]);
  });
});

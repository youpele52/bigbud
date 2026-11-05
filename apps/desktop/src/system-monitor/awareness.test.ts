import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { MonitorEvent } from "@bigbud/contracts/system-monitor/types";
import type { SystemMonitorBridge } from "./bridge";
import { ResourceAwareness } from "./awareness";
import { snapshot } from "./awareness.test.helpers";

const cleanup: (() => Promise<void> | void)[] = [];
const ignoreEvent = () => undefined;
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
  vi.useRealTimers();
});
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "bigbud-awareness-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  let listener: (event: MonitorEvent) => void = ignoreEvent;
  const bridge = {
    appResourceStatus: () => "ready",
    retry: vi.fn(async () => true),
    onEventInternal: vi.fn((next: typeof listener) => {
      listener = next;
      return () => {
        listener = () => undefined;
      };
    }),
    awarenessDemand: vi.fn(async (processes: boolean) => ({
      processes,
      disks: true,
      sensors: true,
      appResources: true,
    })),
    subscribe: vi.fn(async () => 1),
    update: vi.fn(),
    unsubscribe: vi.fn(),
    ack: vi.fn(),
    takeEarlySnapshot: vi.fn(),
    query: vi.fn(async () => ({
      rows: [],
      generation: 1,
      nextDigest: "",
      nextOffset: 0,
      truncatedInventory: false,
      requestId: 1,
    })),
  };
  const owner = new ResourceAwareness(
    bridge as unknown as SystemMonitorBridge,
    join(dir, "preferences.json"),
  );
  cleanup.push(() => owner.stop());
  return { owner, bridge, emit: (event: MonitorEvent) => listener(event) };
}

it("keeps one persistent subscription, ACKs every sample and renews demand while no UI exists", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const { owner, bridge, emit } = await harness();
  bridge.takeEarlySnapshot.mockReturnValueOnce(snapshot());
  await owner.start();
  expect(bridge.ack).toHaveBeenCalledOnce();
  for (let i = 1; i <= 10; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    emit({ type: "snapshot", snapshot: snapshot() });
  }
  expect(bridge.ack).toHaveBeenCalledTimes(11);
  expect(bridge.subscribe).toHaveBeenCalledOnce();
  expect(bridge.update).toHaveBeenCalledTimes(2);
  expect(await owner.readSnapshot()).toEqual(owner.snapshot);
  expect(bridge.subscribe).toHaveBeenCalledOnce();
  expect(owner.state().health).toBe("healthy");
});

it("reconnects with one bounded backoff timer and stops renewing after disposal", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const { owner, bridge, emit } = await harness();
  await owner.start();
  bridge.awarenessDemand.mockRejectedValue(new Error("offline"));
  emit({ type: "unavailable", reason: "offline" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(owner.state().health).toBe("unavailable");
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(vi.getTimerCount()).toBe(1);
  owner.stop();
  const attempts = bridge.awarenessDemand.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(bridge.awarenessDemand).toHaveBeenCalledTimes(attempts);
});

it("disabled background monitoring releases demand, rejects prompt cache reads and leases explicit reads", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const { owner, bridge, emit } = await harness();
  await owner.start();
  emit({ type: "snapshot", snapshot: snapshot() });
  await owner.mutate({ operation: "enable", enabled: false, expectedRevision: 0 });
  expect(bridge.unsubscribe).toHaveBeenCalledWith(1);
  await expect(owner.readSnapshot(true)).rejects.toThrow("disabled");
  await owner.readSnapshot();
  expect(bridge.subscribe).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(bridge.unsubscribe).toHaveBeenCalledTimes(2);
  expect(owner.preferences.value.enabled).toBe(false);
});

it("leases process inventory on the same subscription and does not restart stale cursors", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const { owner, bridge, emit } = await harness();
  await owner.start();
  const pending = owner.query({ sort: "cpu", descending: true, limit: 20 });
  await vi.advanceTimersByTimeAsync(0);
  emit({ type: "snapshot", snapshot: snapshot() });
  await pending;
  expect(bridge.subscribe).toHaveBeenCalledOnce();
  expect(bridge.update).toHaveBeenCalledWith(1, expect.objectContaining({ processes: true }));
  bridge.query.mockRejectedValueOnce(new Error("stale_cursor"));
  await expect(
    owner.query({
      sort: "cpu",
      descending: true,
      limit: 20,
      cursor: { generation: 1, digest: "3", offset: 20 },
    }),
  ).rejects.toThrow("stale_cursor");
  expect(bridge.query).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(20000);
  expect(bridge.update).toHaveBeenLastCalledWith(1, expect.objectContaining({ processes: false }));
});

it("bounds history and resets it after an epoch change", async () => {
  const { owner, emit } = await harness();
  await owner.start();
  for (let i = 1; i <= 350; i++)
    emit({ type: "snapshot", snapshot: snapshot(Date.now(), { sequence: i }) });
  expect(owner.history).toHaveLength(300);
  emit({ type: "snapshot", snapshot: snapshot(Date.now(), { epoch: 2, sequence: 1 }) });
  expect(owner.history).toHaveLength(1);
});

it("recovers failed collection and expired subscriptions without waiting for the monitor page", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const { owner, bridge, emit } = await harness();
  await owner.start();
  emit({
    type: "collectionStatus",
    status: { state: "failed", attempts: 3, retryAfterMs: 0, reason: "collector failed", epoch: 1 },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(bridge.retry).toHaveBeenCalledOnce();
  expect(bridge.subscribe).toHaveBeenCalledTimes(2);
  emit({ type: "snapshot", snapshot: snapshot() });
  emit({
    type: "error",
    error: { requestId: 0, subscriptionId: 1, code: "unknown-subscription", message: "expired" },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(bridge.subscribe).toHaveBeenCalledTimes(3);
});

it("settles pending and subsequent reads on stop without retaining timers", async () => {
  vi.useFakeTimers();
  const { owner } = await harness();
  await owner.start();
  const pending = expect(owner.readSnapshot()).rejects.toThrow("stopped");
  await vi.advanceTimersByTimeAsync(0);
  owner.stop();
  await pending;
  await expect(owner.readSnapshot()).rejects.toThrow("stopped");
  expect(vi.getTimerCount()).toBe(0);
});

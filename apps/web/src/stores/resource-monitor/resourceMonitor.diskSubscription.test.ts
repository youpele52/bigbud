import type { MonitorEvent } from "@bigbud/contracts/system-monitor/types";
import { afterEach, expect, it, vi } from "vitest";
import {
  diskMetric,
  diskMonitorSnapshot,
} from "~/components/resource-monitor/ResourceDisks.fixtures";
import { diskHistoryKey } from "./resourceMonitor.diskHistory";
import { setResourceMonitorConsumer, useResourceMonitorStore } from "./resourceMonitor.store";

afterEach(() => {
  setResourceMonitorConsumer("disks-test", null);
  vi.unstubAllGlobals();
});

it("wires per-disk snapshots into the shared store and clears history on collection or transport failures", async () => {
  let listener: ((event: MonitorEvent) => void) | undefined;
  vi.stubGlobal("window", {
    desktopBridge: {
      systemMonitorSubscribe: async () => 1,
      systemMonitorUpdate: async () => undefined,
      systemMonitorUnsubscribe: async () => undefined,
      systemMonitorAck: async () => undefined,
      onSystemMonitorEvent: (next: typeof listener) => {
        listener = next;
        return () => undefined;
      },
    },
  });
  setResourceMonitorConsumer("disks-test", { disks: true, processes: false, sensors: false });
  await vi.waitFor(() => expect(listener).toBeDefined());
  const snapshot = diskMonitorSnapshot();
  listener!({ type: "snapshot", snapshot });
  const disk = snapshot.disks[0]!;
  const key = diskHistoryKey(disk);
  await vi.waitFor(() =>
    expect(useResourceMonitorStore.getState().diskHistory[key]).toHaveLength(1),
  );
  const next = {
    ...snapshot,
    sequence: 2,
    baseline: false,
    disks: [
      {
        ...disk,
        readBytesPerSecond: diskMetric(12, "ready", 2000),
        writtenBytesPerSecond: diskMetric(24, "ready", 2000),
      },
    ],
  };
  listener!({ type: "snapshot", snapshot: next });
  expect(useResourceMonitorStore.getState().diskHistory[key]).toHaveLength(2);
  listener!({
    type: "collectionStatus",
    status: { state: "retrying", attempts: 1, retryAfterMs: 1000, reason: "sampling", epoch: 1 },
  });
  expect(useResourceMonitorStore.getState().diskHistory).toEqual({});
  listener!({ type: "snapshot", snapshot: { ...next, sequence: 3, baseline: true } });
  expect(useResourceMonitorStore.getState().diskHistory[key]).toHaveLength(1);
  listener!({ type: "unavailable", reason: "Disconnected" });
  expect(useResourceMonitorStore.getState().diskHistory).toEqual({});
  listener!({ type: "snapshot", snapshot: { ...next, sequence: 4, baseline: true } });
  listener!({
    type: "error",
    error: { requestId: 1, subscriptionId: 1, code: "transport", message: "Lost" },
  });
  expect(useResourceMonitorStore.getState().diskHistory).toEqual({});
});

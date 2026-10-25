import type { MonitorEvent } from "@bigbud/contracts/system-monitor/types";
import { afterEach, expect, it, vi } from "vitest";
import {
  diskMetric,
  diskMonitorSnapshot,
} from "~/components/resource-monitor/ResourceDisks.fixtures";
import { diskHistoryKey } from "./resourceMonitor.diskHistory";
import { interfaceMonitorSnapshot } from "~/components/resource-monitor/ResourceNetworkInterfaces.fixtures";
import { interfaceHistoryKey } from "./resourceMonitor.interfaceHistory";
import {
  sensorMetric,
  temperatureSnapshot,
} from "~/components/resource-monitor/ResourceTemperatures.fixtures";
import { temperatureHistoryKey } from "./resourceMonitor.temperatureHistory";
import { setResourceMonitorConsumer, useResourceMonitorStore } from "./resourceMonitor.store";

afterEach(() => {
  setResourceMonitorConsumer("disks-test", null);
  vi.unstubAllGlobals();
});

it("wires named resource histories and clears them on collection or transport failures", async () => {
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
  setResourceMonitorConsumer("disks-test", { disks: true, processes: false, sensors: true });
  await vi.waitFor(() => expect(listener).toBeDefined());
  const snapshot = {
    ...diskMonitorSnapshot(),
    interfaces: interfaceMonitorSnapshot().interfaces,
    temperaturesCelsius: temperatureSnapshot().temperaturesCelsius,
  };
  listener!({ type: "snapshot", snapshot });
  const disk = snapshot.disks[0]!;
  const key = diskHistoryKey(disk);
  await vi.waitFor(() =>
    expect(useResourceMonitorStore.getState().diskHistory[key]).toHaveLength(1),
  );
  const networkKey = interfaceHistoryKey(snapshot.interfaces[0]!);
  expect(useResourceMonitorStore.getState().interfaceHistory[networkKey]).toHaveLength(1);
  const sensor = snapshot.temperaturesCelsius[0]!;
  const sensorKey = temperatureHistoryKey(sensor);
  expect(useResourceMonitorStore.getState().temperatureHistory[sensorKey]).toHaveLength(1);
  const next = {
    ...snapshot,
    sequence: 2,
    baseline: false,
    temperaturesCelsius: [{ ...sensor, metric: sensorMetric(62, "ready", 2000) }],
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
  expect(useResourceMonitorStore.getState().temperatureHistory[sensorKey]).toHaveLength(2);
  listener!({
    type: "collectionStatus",
    status: { state: "retrying", attempts: 1, retryAfterMs: 1000, reason: "sampling", epoch: 1 },
  });
  expect(useResourceMonitorStore.getState().diskHistory).toEqual({});
  expect(useResourceMonitorStore.getState().interfaceHistory).toEqual({});
  expect(useResourceMonitorStore.getState().temperatureHistory).toEqual({});
  listener!({ type: "snapshot", snapshot: { ...next, sequence: 3 } });
  expect(useResourceMonitorStore.getState().interfaceHistory[networkKey]).toHaveLength(1);
  expect(useResourceMonitorStore.getState().temperatureHistory[sensorKey]).toHaveLength(1);
  listener!({
    type: "collectionStatus",
    status: { state: "healthy", attempts: 0, retryAfterMs: 0, reason: "", epoch: 1 },
  });
  listener!({ type: "snapshot", snapshot: { ...next, sequence: 4, baseline: true } });
  expect(useResourceMonitorStore.getState().diskHistory[key]).toHaveLength(1);
  expect(useResourceMonitorStore.getState().interfaceHistory[networkKey]).toHaveLength(1);
  expect(useResourceMonitorStore.getState().temperatureHistory[sensorKey]).toHaveLength(1);
  listener!({ type: "unavailable", reason: "Disconnected" });
  expect(useResourceMonitorStore.getState().diskHistory).toEqual({});
  expect(useResourceMonitorStore.getState().interfaceHistory).toEqual({});
  expect(useResourceMonitorStore.getState().temperatureHistory).toEqual({});
  listener!({ type: "snapshot", snapshot: { ...next, sequence: 5, baseline: true } });
  listener!({
    type: "error",
    error: { requestId: 1, subscriptionId: 1, code: "transport", message: "Lost" },
  });
  expect(useResourceMonitorStore.getState().diskHistory).toEqual({});
  expect(useResourceMonitorStore.getState().interfaceHistory).toEqual({});
  expect(useResourceMonitorStore.getState().temperatureHistory).toEqual({});
});

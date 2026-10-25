import type { MonitorEvent, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setResourceMonitorConsumer, useResourceMonitorStore } from "./resourceMonitor.store";

const base: MonitorSnapshot = {
  subscriptionId: 7,
  epoch: 1,
  sequence: 1,
  baseline: true,
  sampledAtMs: 1000,
  hostname: "desktop",
  osName: "macOS",
  osVersion: "15",
  architecture: "arm64",
  disks: [],
  interfaces: [],
  perCoreTruncated: false,
  disksTruncated: false,
  interfacesTruncated: false,
  sensorsTruncated: false,
  cpuPercent: { value: 25, status: "ready", sampledAtMs: 1000 },
  perCorePercent: [],
  networkReceivedBytesPerSecond: { value: 1024, status: "ready", sampledAtMs: 1000 },
  networkTransmittedBytesPerSecond: { value: 512, status: "ready", sampledAtMs: 1000 },
  temperaturesCelsius: [],
  processStatus: "warming",
  summaryStatus: "ready",
};

afterEach(() => {
  setResourceMonitorConsumer("panel", null);
  setResourceMonitorConsumer("page", null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("system monitor subscription", () => {
  it("reports a silently ignored app demand without breaking System, then recovers on a sample", async () => {
    vi.useFakeTimers();
    let listener: ((event: MonitorEvent) => void) | undefined;
    const update = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      desktopBridge: {
        systemMonitorSubscribe: async () => 7,
        systemMonitorUpdate: update,
        systemMonitorUnsubscribe: async () => undefined,
        systemMonitorAck: async () => undefined,
        onSystemMonitorEvent: (next: typeof listener) => {
          listener = next;
          return () => undefined;
        },
      },
    });
    setResourceMonitorConsumer("panel", {
      processes: false,
      disks: false,
      sensors: false,
      appResources: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    listener?.({ type: "snapshot", snapshot: base });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useResourceMonitorStore.getState().appReason).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useResourceMonitorStore.getState()).toMatchObject({
      connection: "connected",
      snapshot: base,
      appReason: expect.stringContaining("Restart the desktop app"),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useResourceMonitorStore.getState().appReason).toContain("Restart the desktop app");
    listener?.({
      type: "snapshot",
      snapshot: {
        ...base,
        sequence: 2,
        appResources: {
          generation: 1,
          sampledAtMs: base.sampledAtMs,
          incomplete: false,
          core: { role: "desktop", processCount: 1 },
          inclusive: { role: "tools", processCount: 1 },
          groups: [],
        },
      },
    });
    expect(useResourceMonitorStore.getState().appReason).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(useResourceMonitorStore.getState().appReason).toBeNull();
    expect(update).toHaveBeenCalled();
  });
  it("clears the missing-app diagnostic when switching back to System", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      desktopBridge: {
        systemMonitorSubscribe: async () => 7,
        systemMonitorUpdate: async () => undefined,
        systemMonitorUnsubscribe: async () => undefined,
        onSystemMonitorEvent: () => () => undefined,
      },
    });
    setResourceMonitorConsumer("panel", {
      processes: false,
      disks: false,
      sensors: false,
      appResources: true,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(useResourceMonitorStore.getState().appReason).toContain("Restart the desktop app");
    setResourceMonitorConsumer("panel", { processes: false, disks: true, sensors: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(useResourceMonitorStore.getState().appReason).toBeNull();
  });
  it("keeps host snapshots usable while an old monitor rejects app resources", async () => {
    let listener: ((event: MonitorEvent) => void) | undefined;
    const update = vi.fn(async (_id: number, next: { appResources?: boolean }) => {
      if (next.appResources) throw new Error("bigbud monitoring requires monitor protocol 1.3");
    });
    vi.stubGlobal("window", {
      desktopBridge: {
        systemMonitorSubscribe: async () => 7,
        systemMonitorUpdate: update,
        systemMonitorUnsubscribe: async () => undefined,
        systemMonitorAck: async () => undefined,
        onSystemMonitorEvent: (next: typeof listener) => {
          listener = next;
          return () => undefined;
        },
      },
    });
    setResourceMonitorConsumer("panel", { processes: false, disks: true, sensors: false });
    await vi.waitFor(() => expect(listener).toBeDefined());
    await Promise.resolve();
    setResourceMonitorConsumer("page", {
      processes: false,
      disks: false,
      sensors: false,
      appResources: true,
    });
    await vi.waitFor(() =>
      expect(useResourceMonitorStore.getState().appReason).toContain("protocol 1.3"),
    );
    expect(update).toHaveBeenLastCalledWith(7, { processes: false, disks: true, sensors: false });
    listener?.({ type: "snapshot", snapshot: base });
    expect(useResourceMonitorStore.getState().connection).toBe("connected");
    expect(useResourceMonitorStore.getState().appReason).toContain("protocol 1.3");
    setResourceMonitorConsumer("page", null);
    await vi.waitFor(() => expect(useResourceMonitorStore.getState().appReason).toBeNull());
  });
  it("can switch back to System after opening bigbud first with a legacy binary", async () => {
    let listener: ((event: MonitorEvent) => void) | undefined;
    const subscribe = vi.fn(async (next: { appResources?: boolean }) => {
      if (next.appResources) throw new Error("bigbud monitoring requires monitor protocol 1.3");
      return 7;
    });
    const update = vi.fn(async (_id: number, next: { appResources?: boolean }) => {
      if (next.appResources) throw new Error("bigbud monitoring requires monitor protocol 1.3");
    });
    vi.stubGlobal("window", {
      desktopBridge: {
        systemMonitorSubscribe: subscribe,
        systemMonitorUpdate: update,
        systemMonitorUnsubscribe: async () => undefined,
        systemMonitorAck: async () => undefined,
        onSystemMonitorEvent: (next: typeof listener) => {
          listener = next;
          return () => undefined;
        },
      },
    });
    setResourceMonitorConsumer("panel", {
      processes: false,
      disks: false,
      sensors: false,
      appResources: true,
    });
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(update).toHaveBeenLastCalledWith(7, {
        processes: false,
        disks: false,
        sensors: false,
      }),
    );
    listener?.({ type: "snapshot", snapshot: base });
    expect(useResourceMonitorStore.getState().appReason).toContain("protocol 1.3");
    setResourceMonitorConsumer("panel", { processes: false, disks: true, sensors: false });
    await vi.waitFor(() => expect(useResourceMonitorStore.getState().appReason).toBeNull());
    expect(useResourceMonitorStore.getState().connection).toBe("connected");
    expect(subscribe).toHaveBeenCalledTimes(2);
  });
  it("unions visible app and host demands without adding another subscription", async () => {
    const subscribe = vi.fn(async () => 7);
    const update = vi.fn(async () => undefined);
    const unsubscribe = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      desktopBridge: {
        systemMonitorSubscribe: subscribe,
        systemMonitorUpdate: update,
        systemMonitorUnsubscribe: unsubscribe,
        onSystemMonitorEvent: () => () => undefined,
      },
    });
    setResourceMonitorConsumer("panel", {
      processes: false,
      disks: false,
      sensors: false,
      appResources: true,
    });
    setResourceMonitorConsumer("page", { processes: true, disks: true, sensors: true });
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(7, {
        processes: true,
        disks: true,
        sensors: true,
        appResources: true,
      }),
    );
    expect(subscribe).toHaveBeenCalledTimes(1);
    setResourceMonitorConsumer("panel", null);
    expect(update).toHaveBeenLastCalledWith(7, { processes: true, disks: true, sensors: true });
    expect(unsubscribe).not.toHaveBeenCalled();
    setResourceMonitorConsumer("page", null);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("updates union demand when temperature and process details are hidden", async () => {
    const subscribe = vi.fn(async () => 7);
    const update = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      desktopBridge: {
        systemMonitorSubscribe: subscribe,
        systemMonitorUpdate: update,
        systemMonitorUnsubscribe: vi.fn(async () => undefined),
        onSystemMonitorEvent: () => () => undefined,
      },
    });
    setResourceMonitorConsumer("panel", { processes: false, disks: true, sensors: true });
    setResourceMonitorConsumer("page", { processes: true, disks: true, sensors: false });
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(7, {
        processes: true,
        disks: true,
        sensors: true,
      }),
    );
    setResourceMonitorConsumer("panel", { processes: false, disks: true, sensors: false });
    setResourceMonitorConsumer("page", { processes: false, disks: true, sensors: false });
    await vi.waitFor(() =>
      expect(update).toHaveBeenLastCalledWith(7, {
        processes: false,
        disks: true,
        sensors: false,
      }),
    );
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("shares one bridge subscription and clears chart continuity on a sequence gap", async () => {
    let listener: ((event: MonitorEvent) => void) | undefined;
    const subscribe = vi.fn(async () => 7);
    const update = vi.fn(async () => undefined);
    const unsubscribe = vi.fn(async () => undefined);
    const ack = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      desktopBridge: {
        systemMonitorSubscribe: subscribe,
        systemMonitorUpdate: update,
        systemMonitorUnsubscribe: unsubscribe,
        systemMonitorAck: ack,
        onSystemMonitorEvent: (next: (event: MonitorEvent) => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
    });
    setResourceMonitorConsumer("panel", { processes: false, disks: true, sensors: false });
    setResourceMonitorConsumer("page", { processes: true, disks: true, sensors: true });
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(7, { processes: true, disks: true, sensors: true }),
    );
    listener?.({ type: "snapshot", snapshot: base });
    listener?.({
      type: "collectionStatus",
      status: { state: "retrying", attempts: 2, retryAfterMs: 2500, reason: "sampling", epoch: 1 },
    });
    expect(useResourceMonitorStore.getState()).toMatchObject({
      connection: "connected",
      collectionStatus: { state: "retrying", retryAfterMs: 2500 },
    });
    listener?.({
      type: "collectionStatus",
      status: { state: "failed", attempts: 3, retryAfterMs: 0, reason: "sampling", epoch: 1 },
    });
    expect(useResourceMonitorStore.getState()).toMatchObject({
      connection: "connected",
      snapshot: base,
      collectionStatus: { state: "failed" },
    });
    listener?.({
      type: "collectionStatus",
      status: { state: "healthy", attempts: 0, retryAfterMs: 0, reason: "", epoch: 1 },
    });
    expect(useResourceMonitorStore.getState().collectionStatus?.state).toBe("healthy");
    listener?.({ type: "snapshot", snapshot: { ...base, sequence: 2, baseline: false } });
    expect(useResourceMonitorStore.getState().history.cpu).toHaveLength(2);
    expect(useResourceMonitorStore.getState().history.network).toMatchObject([
      { sequence: 1, value: 1024, sentValue: -512 },
      { sequence: 2, value: 1024, sentValue: -512 },
    ]);
    listener?.({
      type: "snapshot",
      snapshot: { ...base, sequence: 3, baseline: false, summaryStatus: "stale" },
    });
    expect(useResourceMonitorStore.getState().history.cpu).toHaveLength(1);
    listener?.({ type: "snapshot", snapshot: { ...base, sequence: 6, baseline: false } });
    expect(useResourceMonitorStore.getState().history.cpu).toHaveLength(1);
    for (let sequence = 7; sequence <= 312; sequence += 1) {
      listener?.({ type: "snapshot", snapshot: { ...base, sequence, baseline: false } });
    }
    expect(useResourceMonitorStore.getState().history.cpu).toHaveLength(300);
    expect(ack).toHaveBeenCalledTimes(310);
    listener?.({ type: "unavailable", reason: "native child exited" });
    expect(useResourceMonitorStore.getState()).toMatchObject({
      connection: "unavailable",
      reason: "native child exited",
      collectionStatus: null,
    });
    setResourceMonitorConsumer("panel", null);
    expect(unsubscribe).not.toHaveBeenCalled();
    setResourceMonitorConsumer("page", null);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

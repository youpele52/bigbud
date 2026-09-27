import type {
  MonitorCollectionStatus,
  MonitorDemand,
  MonitorEvent,
  MonitorSnapshot,
} from "@bigbud/contracts/system-monitor/types";
import { create } from "zustand";

export interface HistoryPoint {
  sequence: number;
  value: number | null;
  sentValue?: number | null;
}
export interface MonitorState {
  snapshot: MonitorSnapshot | null;
  history: Record<"cpu" | "memory" | "network", HistoryPoint[]>;
  connection: "connecting" | "connected" | "unavailable";
  reason: string | null;
  collectionStatus: MonitorCollectionStatus | null;
}

const EMPTY_HISTORY = { cpu: [], memory: [], network: [] };
export const useResourceMonitorStore = create<MonitorState>(() => ({
  snapshot: null,
  history: EMPTY_HISTORY,
  connection: "connecting",
  reason: null,
  collectionStatus: null,
}));

const consumers = new Map<string, MonitorDemand>();
let subscriptionId: number | null = null;
let unsubscribeEvent: (() => void) | null = null;
let renewalTimer: ReturnType<typeof setInterval> | null = null;
let pendingSnapshot: MonitorSnapshot | null = null;
let generation = 0;

function bridge() {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

function markTransportUnavailable() {
  useResourceMonitorStore.setState({
    connection: "unavailable",
    reason: "Resource monitor connection lost",
    collectionStatus: null,
  });
}

function demand(): MonitorDemand {
  const values = [...consumers.values()];
  return {
    processes: values.some((value) => value.processes),
    disks: values.some((value) => value.disks),
    sensors: values.some((value) => value.sensors),
  };
}

function append(
  points: HistoryPoint[],
  value: number | undefined,
  sequence: number,
): HistoryPoint[] {
  if (value === undefined || !Number.isFinite(value)) return points;
  return [...points.slice(-299), { sequence, value }];
}

function appendNetwork(
  points: HistoryPoint[],
  received: number | undefined,
  transmitted: number | undefined,
  sequence: number,
): HistoryPoint[] {
  const safeReceived = received !== undefined && Number.isFinite(received) ? received : undefined;
  const safeTransmitted =
    transmitted !== undefined && Number.isFinite(transmitted) ? transmitted : undefined;
  if (safeReceived === undefined && safeTransmitted === undefined) return points;
  return [
    ...points.slice(-299),
    {
      sequence,
      value: safeReceived ?? null,
      // Negative sent values plot below the chart's zero baseline.
      sentValue: safeTransmitted === undefined ? null : -safeTransmitted,
    },
  ];
}

function acceptSnapshot(snapshot: MonitorSnapshot) {
  if (subscriptionId === null) {
    if (consumers.size > 0) pendingSnapshot = snapshot;
    return;
  }
  if (snapshot.subscriptionId !== subscriptionId) return;
  useResourceMonitorStore.setState((state) => {
    const previous = state.snapshot;
    const continuous =
      previous !== null &&
      previous.epoch === snapshot.epoch &&
      snapshot.sequence === previous.sequence + 1 &&
      !snapshot.baseline &&
      previous.summaryStatus !== "stale" &&
      snapshot.summaryStatus !== "stale" &&
      snapshot.cpuPercent?.status !== "stale" &&
      snapshot.memoryUsedBytes?.status !== "stale" &&
      snapshot.networkReceivedBytesPerSecond?.status !== "stale" &&
      snapshot.networkTransmittedBytesPerSecond?.status !== "stale";
    const history = continuous ? state.history : EMPTY_HISTORY;
    return {
      snapshot,
      connection: "connected",
      reason: null,
      history: {
        cpu: append(
          history.cpu,
          snapshot.cpuPercent?.status === "ready" ? snapshot.cpuPercent.value : undefined,
          snapshot.sequence,
        ),
        memory: append(
          history.memory,
          snapshot.memoryUsedBytes?.status === "ready" ? snapshot.memoryUsedBytes.value : undefined,
          snapshot.sequence,
        ),
        network: appendNetwork(
          history.network,
          snapshot.networkReceivedBytesPerSecond?.status === "ready"
            ? snapshot.networkReceivedBytesPerSecond.value
            : undefined,
          snapshot.networkTransmittedBytesPerSecond?.status === "ready"
            ? snapshot.networkTransmittedBytesPerSecond.value
            : undefined,
          snapshot.sequence,
        ),
      },
    };
  });
  void bridge()
    ?.systemMonitorAck?.(snapshot.subscriptionId, snapshot.epoch, snapshot.sequence)
    .catch(() => {
      useResourceMonitorStore.setState({
        connection: "unavailable",
        reason: "Could not acknowledge resource update",
        collectionStatus: null,
      });
    });
}

function onEvent(event: MonitorEvent) {
  if (event.type === "snapshot") acceptSnapshot(event.snapshot);
  if (event.type === "collectionStatus" && consumers.size > 0)
    useResourceMonitorStore.setState({ collectionStatus: event.status });
  if (event.type === "unavailable")
    useResourceMonitorStore.setState({
      connection: "unavailable",
      reason: event.reason,
      collectionStatus: null,
    });
  if (
    event.type === "error" &&
    subscriptionId !== null &&
    event.error.subscriptionId === subscriptionId
  ) {
    useResourceMonitorStore.setState({
      connection: "unavailable",
      reason: event.error.message,
      collectionStatus: null,
    });
  }
}

async function start() {
  const token = ++generation;
  const api = bridge();
  if (!api?.systemMonitorSubscribe || !api.onSystemMonitorEvent) {
    useResourceMonitorStore.setState({
      connection: "unavailable",
      reason: "Resource monitor is available in the desktop app",
    });
    return;
  }
  unsubscribeEvent = api.onSystemMonitorEvent(onEvent);
  useResourceMonitorStore.setState({
    connection: "connecting",
    reason: null,
    collectionStatus: null,
  });
  try {
    const id = await api.systemMonitorSubscribe(demand());
    if (token !== generation) {
      void api.systemMonitorUnsubscribe?.(id).catch(() => undefined);
      return;
    }
    subscriptionId = id;
    void api.systemMonitorUpdate?.(id, demand()).catch(markTransportUnavailable);
    if (pendingSnapshot?.subscriptionId === id) acceptSnapshot(pendingSnapshot);
    pendingSnapshot = null;
    renewalTimer = setInterval(() => {
      if (subscriptionId !== null)
        void api.systemMonitorUpdate?.(subscriptionId, demand()).catch(markTransportUnavailable);
    }, 5_000);
  } catch (error) {
    useResourceMonitorStore.setState({
      connection: "unavailable",
      reason: error instanceof Error ? error.message : "Resource monitor could not start",
      collectionStatus: null,
    });
  }
}

export function setResourceMonitorConsumer(id: string, next: MonitorDemand | null) {
  if (next) consumers.set(id, next);
  else consumers.delete(id);
  if (consumers.size === 0) {
    generation += 1;
    if (renewalTimer) clearInterval(renewalTimer);
    renewalTimer = null;
    unsubscribeEvent?.();
    unsubscribeEvent = null;
    pendingSnapshot = null;
    if (subscriptionId !== null)
      void bridge()
        ?.systemMonitorUnsubscribe?.(subscriptionId)
        .catch(() => undefined);
    subscriptionId = null;
    useResourceMonitorStore.setState({
      snapshot: null,
      history: EMPTY_HISTORY,
      connection: "connecting",
      reason: null,
      collectionStatus: null,
    });
  } else if (subscriptionId !== null) {
    void bridge()?.systemMonitorUpdate?.(subscriptionId, demand()).catch(markTransportUnavailable);
  } else if (!unsubscribeEvent) {
    void start();
  }
}

export async function retryResourceMonitor() {
  const api = bridge();
  if (!api?.systemMonitorRetry) return false;
  const wasConnected = useResourceMonitorStore.getState().connection === "connected";
  let recovered: boolean;
  try {
    recovered = await api.systemMonitorRetry();
  } catch (error) {
    if (!wasConnected)
      useResourceMonitorStore.setState({
        connection: "unavailable",
        reason: error instanceof Error ? error.message : "Resource monitor retry failed",
        collectionStatus: null,
      });
    return false;
  }
  if (
    recovered &&
    consumers.size > 0 &&
    useResourceMonitorStore.getState().connection === "unavailable"
  ) {
    if (subscriptionId !== null)
      void api.systemMonitorUnsubscribe?.(subscriptionId).catch(() => undefined);
    subscriptionId = null;
    unsubscribeEvent?.();
    unsubscribeEvent = null;
    if (renewalTimer) clearInterval(renewalTimer);
    renewalTimer = null;
    void start();
  }
  return recovered;
}

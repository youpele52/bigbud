import type {
  MonitorMetric,
  MonitorNetworkInterface,
} from "@bigbud/contracts/system-monitor/types";
import {
  interfaceHistoryKey,
  type InterfaceHistory,
} from "~/stores/resource-monitor/resourceMonitor.interfaceHistory";
import { appMonitorSnapshot } from "./BigbudResourceView.fixtures";

export function interfaceMetric(
  value: number,
  status: MonitorMetric["status"] = "ready",
  sampledAtMs = 1000,
): MonitorMetric {
  return { value, status, sampledAtMs };
}

/** Include busy, idle and down interfaces without suggesting activity-based ordering. */
export function monitorInterfaces(): MonitorNetworkInterface[] {
  return [
    {
      name: "en0",
      linkState: { value: "up", status: "ready", sampledAtMs: 1000 },
      mtuBytes: interfaceMetric(1500),
      receivedBytesPerSecond: interfaceMetric(1.4 * 1024 ** 2),
      transmittedBytesPerSecond: interfaceMetric(1.39 * 1024 ** 2),
      receivedTotalBytes: interfaceMetric(79.9 * 1024 ** 3),
      transmittedTotalBytes: interfaceMetric(12.17 * 1024 ** 3),
      receivedPackets: interfaceMetric(79878805),
      transmittedPackets: interfaceMetric(35404875),
      receiveErrors: interfaceMetric(0),
      transmitErrors: interfaceMetric(2),
    },
    {
      name: "bridge0",
      linkState: { value: "up", status: "ready", sampledAtMs: 1000 },
      mtuBytes: interfaceMetric(1500),
      receivedBytesPerSecond: interfaceMetric(0),
      transmittedBytesPerSecond: interfaceMetric(0),
      receivedTotalBytes: interfaceMetric(86 * 1024 ** 2),
      transmittedTotalBytes: interfaceMetric(8.06 * 1024 ** 2),
      receivedPackets: interfaceMetric(1),
      transmittedPackets: interfaceMetric(30814),
      receiveErrors: interfaceMetric(0),
      transmitErrors: interfaceMetric(0),
    },
    {
      name: "awdl0",
      linkState: { value: "down", status: "ready", sampledAtMs: 1000 },
      receivedBytesPerSecond: interfaceMetric(0),
      transmittedBytesPerSecond: interfaceMetric(0),
    },
  ];
}

export function interfaceMonitorSnapshot() {
  return { ...appMonitorSnapshot(), interfaces: monitorInterfaces() };
}

export function interfaceMonitorHistory(): InterfaceHistory {
  return Object.fromEntries(
    monitorInterfaces().map((item) => [
      interfaceHistoryKey(item),
      Array.from({ length: 30 }, (_, sequence) => ({
        sequence,
        value: item.receivedBytesPerSecond!.value * (0.7 + Math.sin(sequence / 2) / 4),
        sentValue: -item.transmittedBytesPerSecond!.value * (0.7 + Math.cos(sequence / 2) / 4),
      })),
    ]),
  );
}

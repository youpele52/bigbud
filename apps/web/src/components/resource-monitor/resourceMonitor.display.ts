import type { MonitorMetric, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";

import type { ResourceWidget } from "~/stores/resource-monitor/resourceMonitorPreferences.store";
import type { DisplayMetric } from "./ResourceMetricCard";
import {
  formatBytes,
  formatPercent,
  formatRate,
  formatTemperature,
} from "./resourceMonitor.format";

function show(metric: MonitorMetric | undefined, format: (value: number) => string): string {
  return metric?.status === "ready" ? format(metric.value) : "—";
}

function status(metric: MonitorMetric | undefined): string {
  return metric?.status ?? "unavailable";
}

export function hasTemperature(snapshot: MonitorSnapshot | null): boolean {
  return (
    snapshot?.temperaturesCelsius.some(
      ({ metric }) => metric.status === "ready" || metric.status === "warming",
    ) ?? false
  );
}

export function displayWidget(
  snapshot: MonitorSnapshot | null,
  widget: ResourceWidget,
): DisplayMetric {
  if (!snapshot) return { label: WIDGET_LABELS[widget], value: "—", status: "warming" };
  switch (widget) {
    case "cpu":
      return {
        label: "CPU",
        value: show(snapshot.cpuPercent, formatPercent),
        status: status(snapshot.cpuPercent),
        ...(snapshot.perCorePercent.length
          ? { detail: `${snapshot.perCorePercent.length} logical cores` }
          : {}),
      };
    case "memory":
      return {
        label: "Memory",
        value: show(snapshot.memoryUsedBytes, formatBytes),
        status: status(snapshot.memoryUsedBytes),
        detail: `${show(snapshot.memoryTotalBytes, formatBytes)} total · ${show(snapshot.swapUsedBytes, formatBytes)} swap used`,
      };
    case "disk": {
      const singleDisk = snapshot.disks.length === 1 ? snapshot.disks[0] : undefined;
      const capacity =
        snapshot.diskCapacityBytes?.status === "ready"
          ? snapshot.diskCapacityBytes
          : singleDisk?.totalBytes;
      return {
        label: "Disk",
        value: show(capacity, formatBytes),
        status: status(capacity ?? snapshot.diskCapacityBytes),
        detail:
          singleDisk && capacity === singleDisk.totalBytes
            ? `${singleDisk.name} capacity`
            : "Combined capacity",
      };
    }
    case "network":
      return {
        label: "Network",
        value: `↓ ${show(snapshot.networkReceivedBytesPerSecond, formatRate)} · ↑ ${show(snapshot.networkTransmittedBytesPerSecond, formatRate)}`,
        status:
          snapshot.networkReceivedBytesPerSecond?.status === "ready" &&
          snapshot.networkTransmittedBytesPerSecond?.status === "ready"
            ? "ready"
            : status(snapshot.networkReceivedBytesPerSecond),
      };
    case "temperature": {
      const sensor =
        snapshot.temperaturesCelsius.find(({ metric }) => metric.status === "ready") ??
        snapshot.temperaturesCelsius[0];
      return {
        label: "Temperature",
        value: show(sensor?.metric, formatTemperature),
        status: status(sensor?.metric),
        ...(sensor?.name ? { detail: sensor.name } : {}),
      };
    }
  }
}

export const WIDGET_LABELS: Record<ResourceWidget, string> = {
  cpu: "CPU",
  memory: "Memory",
  disk: "Disk",
  network: "Network",
  temperature: "Temperature",
};

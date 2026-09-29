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
        historyValueFormatter: formatPercent,
        ...(snapshot.perCorePercent.length
          ? { detail: `${snapshot.perCorePercent.length} logical cores` }
          : {}),
      };
    case "memory":
      return {
        label: "Memory",
        value: show(snapshot.memoryUsedBytes, formatBytes),
        status: status(snapshot.memoryUsedBytes),
        historyValueFormatter: formatBytes,
        detail: `${show(snapshot.memoryTotalBytes, formatBytes)} total · ${show(snapshot.swapUsedBytes, formatBytes)} swap used`,
      };
    case "disk": {
      // Show one named volume: mounted volumes may share backing storage, so
      // neither their free space nor their capacities are safe to sum here.
      const disk =
        snapshot.disks.find((item) => item.mount === "/") ??
        snapshot.disks.toSorted((a, b) => {
          const left = `${a.mount}\0${a.name}`;
          const right = `${b.mount}\0${b.name}`;
          return left < right ? -1 : left > right ? 1 : 0;
        })[0];
      if (!disk) {
        return {
          label: "Disk",
          value: "— free",
          status: "unavailable",
          detail: `${show(snapshot.diskCapacityBytes, formatBytes)} total · Free space unavailable`,
        };
      }
      const volume = snapshot.disks.length > 1 ? `${disk.name} (${disk.mount})` : disk.name;
      const total = disk.totalBytes;
      const free = disk.freeBytes;
      const diskUsage =
        total?.status === "ready" &&
        free?.status === "ready" &&
        Number.isFinite(total.value) &&
        Number.isFinite(free.value) &&
        total.value > 0 &&
        free.value >= 0 &&
        free.value <= total.value
          ? { totalBytes: total.value, freeBytes: free.value }
          : undefined;
      return {
        label: "Disk",
        value: `${show(disk.freeBytes, formatBytes)} free`,
        status:
          disk.freeBytes?.status === "ready" ? status(disk.totalBytes) : status(disk.freeBytes),
        detail: `${show(disk.totalBytes, formatBytes)} total · ${volume}`,
        ...(diskUsage ? { diskUsage } : {}),
      };
    }
    case "network":
      return {
        label: "Network",
        value: `↓ ${show(snapshot.networkReceivedBytesPerSecond, formatRate)} · ↑ ${show(snapshot.networkTransmittedBytesPerSecond, formatRate)}`,
        historyValueFormatter: formatRate,
        historyStyle: "network",
        status:
          snapshot.networkReceivedBytesPerSecond?.status === "ready"
            ? status(snapshot.networkTransmittedBytesPerSecond)
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

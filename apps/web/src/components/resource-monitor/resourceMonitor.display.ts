import type { MonitorMetric, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";

import type { ResourceWidget } from "~/stores/resource-monitor/resourceMonitorPreferences.store";
import type { DisplayMetric } from "./ResourceMetricCard";
import { capacityValue, formatCapacityGiB } from "./ResourceCapacityUsage.logic";
import { diskCapacityUsage } from "./resourceMonitor.display.disk";
import { cpuUsageValue } from "./resourceMonitor.display.cpu";
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
  if (!snapshot) {
    return {
      label: WIDGET_LABELS[widget],
      value: "—",
      status: "warming",
      ...(widget === "cpu" ? { gaugeValue: null } : {}),
      ...(widget === "memory" || widget === "disk"
        ? {
            capacityUsage: {
              usedBytes: null,
              totalBytes: null,
              footer: [],
            },
          }
        : {}),
      ...(widget === "network"
        ? { networkRates: { download: "—", upload: "—" }, historyStyle: "network" as const }
        : {}),
    };
  }
  switch (widget) {
    case "cpu":
      return {
        label: "CPU",
        value: show(snapshot.cpuPercent, formatPercent),
        status: status(snapshot.cpuPercent),
        gaugeValue: cpuUsageValue(snapshot.cpuPercent),
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
        capacityUsage: {
          usedBytes: capacityValue(snapshot.memoryUsedBytes),
          totalBytes: capacityValue(snapshot.memoryTotalBytes),
          footer: [
            `Available: ${formatCapacityGiB(capacityValue(snapshot.memoryAvailableBytes))}`,
            `Swap: ${formatCapacityGiB(capacityValue(snapshot.swapUsedBytes))} used / ${formatCapacityGiB(capacityValue(snapshot.swapTotalBytes))} total`,
          ],
        },
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
          capacityUsage: {
            usedBytes: null,
            totalBytes: null,
            footer: ["Free space and volume unavailable"],
          },
        };
      }
      const volume = snapshot.disks.length > 1 ? `${disk.name} (${disk.mount})` : disk.name;
      return {
        label: "Disk",
        value: `${show(disk.freeBytes, formatBytes)} free`,
        status:
          disk.freeBytes?.status === "ready" ? status(disk.totalBytes) : status(disk.freeBytes),
        detail: `${show(disk.totalBytes, formatBytes)} total · ${volume}`,
        capacityUsage: diskCapacityUsage(disk),
      };
    }
    case "network":
      return {
        label: "Network",
        value: `↓ ${show(snapshot.networkReceivedBytesPerSecond, formatRate)} · ↑ ${show(snapshot.networkTransmittedBytesPerSecond, formatRate)}`,
        networkRates: {
          download: show(snapshot.networkReceivedBytesPerSecond, formatRate),
          upload: show(snapshot.networkTransmittedBytesPerSecond, formatRate),
        },
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

import type { MonitorDisk } from "@bigbud/contracts/system-monitor/types";
import {
  capacityValue,
  formatCapacityGiB,
  type CapacityUsage,
} from "./ResourceCapacityUsage.logic";

/** Pair capacity readings from one volume; never sum potentially duplicated mounts. */
export function diskCapacityUsage(disk: MonitorDisk): CapacityUsage {
  const total = capacityValue(disk.totalBytes);
  const free = capacityValue(disk.freeBytes);
  return {
    usedBytes:
      disk.usedBytes !== undefined
        ? capacityValue(disk.usedBytes)
        : total !== null && free !== null && free <= total
          ? total - free
          : null,
    totalBytes: total,
    footer: [`Free: ${formatCapacityGiB(free)}`, `${disk.name || "Volume"} (${disk.mount})`],
  };
}

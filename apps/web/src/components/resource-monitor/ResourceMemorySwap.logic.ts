import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import {
  capacityValue,
  formatCapacityGiB,
  type CapacityUsage,
} from "./ResourceCapacityUsage.logic";

export interface MemorySwapUsage {
  ram: CapacityUsage;
  swap: CapacityUsage;
  noSwap: boolean;
}

/** Available RAM is collector-provided reclaimable memory, not total minus used memory. */
export function memorySwapUsage(
  snapshot: MonitorSnapshot | null,
  current: boolean,
): MemorySwapUsage {
  const sample = current ? snapshot : null;
  const swapUsed = capacityValue(sample?.swapUsedBytes);
  const swapTotal = capacityValue(sample?.swapTotalBytes);
  return {
    ram: {
      usedBytes: capacityValue(sample?.memoryUsedBytes),
      totalBytes: capacityValue(sample?.memoryTotalBytes),
      footer: [`Available: ${formatCapacityGiB(capacityValue(sample?.memoryAvailableBytes))}`],
    },
    swap: {
      usedBytes: swapUsed,
      totalBytes: swapTotal,
      footer: [`Free: ${formatCapacityGiB(capacityValue(sample?.swapFreeBytes))}`],
    },
    noSwap: swapUsed === 0 && swapTotal === 0,
  };
}

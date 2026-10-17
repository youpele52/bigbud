import type { MonitorMetric, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { appMonitorSnapshot } from "./BigbudResourceView.fixtures";

export function memorySwapMetric(
  gib: number,
  status: MonitorMetric["status"] = "ready",
): MonitorMetric {
  return { value: gib * 1024 ** 3, status, sampledAtMs: 1000 };
}

/** Available RAM intentionally differs from total minus used, matching reclaimable accounting. */
export function memorySwapSnapshot(): MonitorSnapshot {
  return {
    ...appMonitorSnapshot(),
    memoryTotalBytes: memorySwapMetric(64),
    memoryUsedBytes: memorySwapMetric(53.18),
    memoryAvailableBytes: memorySwapMetric(28.14),
    swapTotalBytes: memorySwapMetric(4),
    swapUsedBytes: memorySwapMetric(2.91),
    swapFreeBytes: memorySwapMetric(1.09),
  };
}

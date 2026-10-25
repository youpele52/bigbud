import type { MonitorMetric } from "@bigbud/contracts/system-monitor/types";
import { usagePercentBand } from "../ui/usageBands.logic";

/** Only measured, nonnegative capacities can be used in bars and totals. */
export function capacityValue(metric: MonitorMetric | undefined): number | null {
  return metric?.status === "ready" && Number.isFinite(metric.value) && metric.value >= 0
    ? metric.value
    : null;
}

export interface CapacityUsage {
  usedBytes: number | null;
  totalBytes: number | null;
  footer: readonly string[];
}

/** Preserve over-capacity memory estimates only when explicitly allowed; unknowns are never zero. */
export function capacityPercent(
  usage: Pick<CapacityUsage, "usedBytes" | "totalBytes">,
  allowOverCapacity = false,
): number | null {
  const { usedBytes, totalBytes } = usage;
  return usedBytes !== null &&
    totalBytes !== null &&
    Number.isFinite(usedBytes) &&
    Number.isFinite(totalBytes) &&
    totalBytes > 0 &&
    usedBytes >= 0 &&
    (allowOverCapacity || usedBytes <= totalBytes) &&
    Number.isFinite((usedBytes / totalBytes) * 100)
    ? (usedBytes / totalBytes) * 100
    : null;
}

export function capacitySeverity(
  percent: number | null,
): "unknown" | "neutral" | "warning" | "critical" {
  return usagePercentBand(percent)?.severity ?? "unknown";
}

/** Keep status wording consistent across capacity bar and gauge accessibility descriptions. */
export function capacityUsageStatus(percent: number | null): string {
  const severity = capacitySeverity(percent);
  return severity === "critical"
    ? "Critical usage"
    : severity === "warning"
      ? "High usage"
      : severity === "neutral"
        ? "Normal usage"
        : "Usage unavailable";
}

export function formatCapacityGiB(bytes: number | null): string {
  return bytes === null || !Number.isFinite(bytes) || bytes < 0
    ? "—"
    : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

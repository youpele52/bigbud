export interface CapacityUsage {
  usedBytes: number | null;
  totalBytes: number | null;
  footer: readonly string[];
}

/** Reject unknown or inconsistent capacities rather than showing a false zero. */
export function capacityPercent(
  usage: Pick<CapacityUsage, "usedBytes" | "totalBytes">,
): number | null {
  const { usedBytes, totalBytes } = usage;
  return usedBytes !== null &&
    totalBytes !== null &&
    Number.isFinite(usedBytes) &&
    Number.isFinite(totalBytes) &&
    totalBytes > 0 &&
    usedBytes >= 0 &&
    usedBytes <= totalBytes
    ? (usedBytes / totalBytes) * 100
    : null;
}

export function capacitySeverity(
  percent: number | null,
): "unknown" | "neutral" | "warning" | "critical" {
  if (percent === null || !Number.isFinite(percent)) return "unknown";
  return percent >= 95 ? "critical" : percent >= 80 ? "warning" : "neutral";
}

export function formatCapacityGiB(bytes: number | null): string {
  return bytes === null || !Number.isFinite(bytes) || bytes < 0
    ? "—"
    : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

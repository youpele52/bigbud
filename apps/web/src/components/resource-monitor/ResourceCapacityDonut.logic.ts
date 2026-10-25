export interface CapacityUsage {
  used: number;
  total: number;
}

/** Clamp only the drawn arc: summed resident-memory estimates can exceed physical RAM. */
export function capacityDonutData(usage: CapacityUsage | undefined) {
  if (
    !usage ||
    !Number.isFinite(usage.used) ||
    !Number.isFinite(usage.total) ||
    usage.used < 0 ||
    usage.total <= 0
  )
    return undefined;
  const percentage = (usage.used / usage.total) * 100;
  if (!Number.isFinite(percentage)) return undefined;
  const drawn = Math.min(percentage, 100);
  return {
    percentage,
    exceedsCapacity: percentage > 100,
    slices: [
      { name: "Core bigbud", value: drawn, fill: "var(--chart-1)" },
      { name: "Remaining capacity", value: 100 - drawn, fill: "var(--muted)" },
    ],
  };
}

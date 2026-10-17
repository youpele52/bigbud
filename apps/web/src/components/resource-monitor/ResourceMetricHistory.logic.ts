import type { DisplayMetric, DisplayPoint } from "./ResourceMetricCard";

/** Preserve gaps in sampled history rather than presenting missing values as zero. */
export function formatHistoryTooltipValue(
  value: unknown,
  formatter: DisplayMetric["historyValueFormatter"],
  absolute = false,
): string {
  if (value === null || value === undefined) return "—";
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "—";
  const displayValue = absolute ? Math.abs(numeric) : numeric;
  return formatter?.(displayValue) ?? displayValue.toFixed(2);
}

export function networkDomain(history: readonly DisplayPoint[] | undefined): [number, number] {
  const extent = history?.reduce(
    (largest, point) =>
      Math.max(largest, Math.abs(point.value ?? 0), Math.abs(point.sentValue ?? 0)),
    0,
  );
  const limit = extent && extent > 0 ? extent : 1;
  return [-limit, limit];
}

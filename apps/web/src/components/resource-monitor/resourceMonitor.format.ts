import { formatBytes } from "@bigbud/shared/bytes";

export function formatDecimal(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(2);
}

export function formatPercent(value: number | null | undefined): string {
  const formatted = formatDecimal(value);
  return formatted === "—" ? formatted : `${formatted}%`;
}

/** Keep percentage gauge scale labels compact without rounding live readings. */
export function formatPercentEndpoint(value: number): string {
  return `${value.toFixed(0)}%`;
}

export function formatTemperature(value: number | null | undefined): string {
  const formatted = formatDecimal(value);
  return formatted === "—" ? formatted : `${formatted} °C`;
}

export function formatRate(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : `${formatBytes(value)}/s`;
}

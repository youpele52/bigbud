export interface UsageBand {
  /** Exclusive upper bound as a fraction of the range; the last band includes the endpoint. */
  to: number;
  color: string;
}

export const DEFAULT_USAGE_BANDS = [
  { to: 0.5, color: "var(--chart-1)", severity: "neutral" },
  { to: 0.8, color: "var(--chart-3)", severity: "warning" },
  { to: 1, color: "var(--chart-4)", severity: "critical" },
] as const satisfies readonly (UsageBand & { severity: "neutral" | "warning" | "critical" })[];

/** Resolve fractional bands and custom palettes, with the final band covering overflow. */
export function usageBand<T extends UsageBand>(
  fraction: number,
  bands: readonly T[],
): T | undefined {
  return bands.find((band) => fraction < band.to) ?? bands.at(-1);
}

/** Custom gauge palettes retain their fallback even when no bands are supplied. */
export function usageBandColor(fraction: number, bands: readonly UsageBand[]): string {
  return usageBand(fraction, bands)?.color ?? "var(--chart-1)";
}

/** Unknown percentages stay uncolored; finite over-capacity estimates retain the highest band. */
export function usagePercentBand(percent: number | null | undefined) {
  return percent == null || !Number.isFinite(percent)
    ? undefined
    : usageBand(percent / 100, DEFAULT_USAGE_BANDS);
}

/** Use the same theme palette for percentage bars and gauge readings. */
export function usagePercentColor(percent: number | null | undefined): string {
  return usagePercentBand(percent)?.color ?? "var(--muted-foreground)";
}

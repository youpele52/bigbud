export interface GaugeBand {
  /** Exclusive upper bound as a fraction of the gauge's range; the last band includes the endpoint. */
  to: number;
  color: string;
}

export const DEFAULT_GAUGE_BANDS: readonly GaugeBand[] = [
  { to: 0.5, color: "var(--chart-1)" },
  { to: 0.8, color: "var(--chart-3)" },
  { to: 1, color: "var(--chart-4)" },
];

/** Invalid readings stay unavailable; valid readings are clamped to the configured range. */
export function gaugeReading(value: number | null | undefined, min: number, max: number) {
  const range = max - min;
  if (
    value == null ||
    !Number.isFinite(value) ||
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    !Number.isFinite(range) ||
    range <= 0
  )
    return undefined;
  const current = Math.min(max, Math.max(min, value));
  const fraction = (current - min) / range;
  return { value: current, fraction, angle: fraction * 180 };
}

/** Resolve decorative usage bands without assigning warning or failure semantics. */
export function gaugeColor(fraction: number, bands: readonly GaugeBand[]) {
  return bands.find((band) => fraction < band.to)?.color ?? bands.at(-1)?.color ?? "var(--chart-1)";
}

/** Keep SVG work bounded even when segment density is supplied by a consumer. */
export function gaugeSegments(count: number) {
  const length = Number.isFinite(count) ? Math.min(80, Math.max(8, Math.round(count))) : 40;
  return Array.from({ length }, (_, index) => {
    const fraction = index / (length - 1);
    const angle = Math.PI * (1 - fraction);
    const inner = index % 5 === 0 ? 73 : 78;
    return {
      index,
      fraction,
      x1: 120 + inner * Math.cos(angle),
      y1: 108 - inner * Math.sin(angle),
      x2: 120 + 90 * Math.cos(angle),
      y2: 108 - 90 * Math.sin(angle),
    };
  });
}

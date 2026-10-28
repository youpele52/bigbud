/**
 * Desktop scroll normalization shared by the selected legacy route and the
 * dormant v2 validation (plan M3 "Preserve existing scroll units/normalization").
 *
 * Omitted deltas are zero; both zero is refused; the dominant absolute axis
 * wins with vertical winning ties; the dominant magnitude is rounded and
 * clamped to 1–100 and the minor axis is ignored. No new units API.
 */
export type ScrollDirection = "up" | "down" | "left" | "right";

export interface NormalizedScroll {
  readonly direction: ScrollDirection;
  /** Integer in [1, SCROLL_MAX_AMOUNT]. */
  readonly amount: number;
}

export const SCROLL_MAX_AMOUNT = 100;
/** cua-driver macOS `scroll` accepts at most 50 per call. */
export const MACOS_SCROLL_CHUNK_MAX = 50;

/** Returns null when both deltas are zero/omitted (the caller refuses). */
export function normalizeScroll(
  deltaX: number | undefined,
  deltaY: number | undefined,
): NormalizedScroll | null {
  const x = deltaX ?? 0;
  const y = deltaY ?? 0;
  if (x === 0 && y === 0) return null;
  const vertical = Math.abs(y) >= Math.abs(x);
  const dominant = vertical ? y : x;
  const direction: ScrollDirection = vertical
    ? dominant < 0
      ? "up"
      : "down"
    : dominant < 0
      ? "left"
      : "right";
  const amount = Math.min(SCROLL_MAX_AMOUNT, Math.max(1, Math.round(Math.abs(dominant))));
  return { direction, amount };
}

/**
 * Splits a normalized amount into ordered chunks of at most `maxChunk` whose
 * sum is exactly `amount`. Authority is rechecked between chunks by the
 * caller; a failure reports the delivered prefix, never a replay.
 */
export function chunkScrollAmount(amount: number, maxChunk: number): ReadonlyArray<number> {
  if (
    !Number.isInteger(amount) ||
    amount < 1 ||
    amount > SCROLL_MAX_AMOUNT ||
    !Number.isInteger(maxChunk) ||
    maxChunk < 1
  ) {
    throw new RangeError("scroll chunking requires a normalized amount and positive chunk size");
  }
  const chunks: number[] = [];
  for (let remaining = amount; remaining > 0; remaining -= maxChunk) {
    chunks.push(Math.min(maxChunk, remaining));
  }
  return chunks;
}

const sum = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0);

/** Partial-delivery counts for a chunked scroll stopped after `deliveredChunks`. */
export function scrollDeliveryCounts(
  chunks: ReadonlyArray<number>,
  deliveredChunks: number,
): { readonly delivered: number; readonly requested: number } {
  const bounded = Math.max(0, Math.min(chunks.length, Math.trunc(deliveredChunks)));
  return { delivered: sum(chunks.slice(0, bounded)), requested: sum(chunks) };
}

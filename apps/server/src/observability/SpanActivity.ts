/**
 * Bounded record of running and recently ended spans, used to say what the
 * server was doing when its event loop stalled. A synchronous culprit (for
 * example a long `sql.execute`) has usually ended by the time the stall is
 * observed, so recently ended spans are kept alongside running ones.
 */
export interface SpanActivityEntry {
  readonly name: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
}

export interface SpanActivityShape {
  readonly started: (spanId: string, name: string, startedAtMs: number) => void;
  readonly ended: (spanId: string, endedAtMs: number) => void;
  /** Spans overlapping the stall window, likeliest culprit first (see `rankStallSpans`). */
  readonly stallCandidates: (
    fromMs: number,
    toMs: number,
    limit: number,
  ) => ReadonlyArray<SpanActivityEntry>;
}

export const SPAN_ACTIVITY_ACTIVE_CAPACITY = 4_096;
export const SPAN_ACTIVITY_ENDED_CAPACITY = 512;

/**
 * A span that started more than this long before a stall and is still running
 * after it is background (a socket, a subscription), not the stall's cause.
 */
export const STALL_BACKGROUND_LEAD_MS = 1_000;

const overlapMs = (entry: SpanActivityEntry, fromMs: number, toMs: number): number =>
  Math.min(entry.endedAtMs ?? toMs, toMs) - Math.max(entry.startedAtMs, fromMs);

const isBackground = (entry: SpanActivityEntry, fromMs: number, toMs: number): boolean =>
  entry.startedAtMs < fromMs - STALL_BACKGROUND_LEAD_MS &&
  (entry.endedAtMs === null || entry.endedAtMs > toMs);

/**
 * Orders spans by how likely they caused the stall [fromMs, toMs]. Spans that
 * do not overlap the window are dropped. Long-lived background spans go last.
 * Within each group the longest overlap comes first, then the latest start,
 * which puts the synchronous span that covered the freeze at the top.
 */
export function rankStallSpans(
  entries: Iterable<SpanActivityEntry>,
  fromMs: number,
  toMs: number,
  limit: number,
): ReadonlyArray<SpanActivityEntry> {
  const ranked: Array<{ entry: SpanActivityEntry; overlap: number; background: boolean }> = [];
  for (const entry of entries) {
    const overlap = overlapMs(entry, fromMs, toMs);
    if (overlap <= 0) continue;
    ranked.push({ entry, overlap, background: isBackground(entry, fromMs, toMs) });
  }
  return ranked
    .toSorted(
      (left, right) =>
        Number(left.background) - Number(right.background) ||
        right.overlap - left.overlap ||
        right.entry.startedAtMs - left.entry.startedAtMs,
    )
    .slice(0, Math.max(0, limit))
    .map(({ entry }) => entry);
}

export class SpanActivityTracker implements SpanActivityShape {
  private readonly active = new Map<string, { name: string; startedAtMs: number }>();
  private readonly endedRing: Array<SpanActivityEntry | undefined>;
  private endedNext = 0;

  constructor(
    private readonly activeCapacity = SPAN_ACTIVITY_ACTIVE_CAPACITY,
    endedCapacity = SPAN_ACTIVITY_ENDED_CAPACITY,
  ) {
    this.endedRing = Array.from({ length: Math.max(1, endedCapacity) });
  }

  started(spanId: string, name: string, startedAtMs: number): void {
    // Leaked spans must not grow memory; past capacity new spans are simply not attributed.
    if (this.active.size >= this.activeCapacity) return;
    this.active.set(spanId, { name, startedAtMs });
  }

  ended(spanId: string, endedAtMs: number): void {
    const entry = this.active.get(spanId);
    if (!entry) return;
    this.active.delete(spanId);
    this.endedRing[this.endedNext] = { ...entry, endedAtMs };
    this.endedNext = (this.endedNext + 1) % this.endedRing.length;
  }

  stallCandidates(fromMs: number, toMs: number, limit: number): ReadonlyArray<SpanActivityEntry> {
    const entries: SpanActivityEntry[] = [];
    for (const entry of this.active.values()) entries.push({ ...entry, endedAtMs: null });
    for (const entry of this.endedRing) if (entry) entries.push(entry);
    return rankStallSpans(entries, fromMs, toMs, limit);
  }
}

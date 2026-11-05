import type {
  ServerUsageBucket,
  ServerUsageRange,
  ServerUsageSummaryResult,
} from "@bigbud/contracts/server/usage.ts";

import type { BreakdownPieEntry } from "./UsageBreakdownCard.pie.logic";

export type UsageTimelineBucket = ServerUsageBucket & { readonly empty: boolean };
export type UsageBucketShareField = "providers" | "models";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RANGE_SPAN_MS: Record<Exclude<ServerUsageRange, "all">, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};
// Guards against a corrupt timestamp turning the fill into an unbounded loop.
const MAX_TIMELINE_BUCKETS = 1_000;

/** Mirrors the server's UTC bucketing in wsRpcHandlers.usage.ts. */
function floorBucketStart(ms: number, range: ServerUsageRange): number {
  const date = new Date(ms);
  if (range === "all") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  if (range === "24h") return Math.floor(ms / HOUR_MS) * HOUR_MS;
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function nextBucketStart(ms: number, range: ServerUsageRange): number {
  if (range === "24h") return ms + HOUR_MS;
  if (range !== "all") return ms + DAY_MS;
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function emptyBucket(ms: number): UsageTimelineBucket {
  return {
    bucketStart: new Date(ms).toISOString(),
    usedTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    turnCount: 0,
    providers: [],
    models: [],
    empty: true,
  };
}

/** Zero-fills the server's sparse buckets so every chart shares one honest time axis. */
export function fillUsageTimeline(
  summary: Pick<ServerUsageSummaryResult, "range" | "generatedAt" | "buckets">,
): UsageTimelineBucket[] {
  const known = new Map<number, ServerUsageBucket>();
  for (const bucket of summary.buckets) {
    const ms = new Date(bucket.bucketStart).getTime();
    if (Number.isFinite(ms)) known.set(floorBucketStart(ms, summary.range), bucket);
  }
  if (known.size === 0) return [];

  const generatedMs = new Date(summary.generatedAt).getTime();
  const knownStarts = Array.from(known.keys());
  const end = Number.isFinite(generatedMs)
    ? Math.max(floorBucketStart(generatedMs, summary.range), ...knownStarts)
    : Math.max(...knownStarts);
  const rangeStart =
    summary.range === "all" || !Number.isFinite(generatedMs)
      ? Number.POSITIVE_INFINITY
      : floorBucketStart(generatedMs - RANGE_SPAN_MS[summary.range], summary.range);
  const start = Math.min(rangeStart, ...knownStarts);

  const timeline: UsageTimelineBucket[] = [];
  for (
    let ms = start;
    ms <= end && timeline.length < MAX_TIMELINE_BUCKETS;
    ms = nextBucketStart(ms, summary.range)
  ) {
    const bucket = known.get(ms);
    timeline.push(bucket ? { ...bucket, empty: false } : emptyBucket(ms));
  }
  return timeline;
}

/** Older servers send buckets without a split; Trend falls back to the split view. */
export function hasUsageBucketShares(
  timeline: ReadonlyArray<UsageTimelineBucket>,
  field: UsageBucketShareField,
): boolean {
  const active = timeline.filter((bucket) => !bucket.empty);
  return active.length > 0 && active.every((bucket) => bucket[field] !== undefined);
}

export type UsageTrendRow = { readonly bucketStart: string } & Record<string, number | string>;

export const breakdownSeriesKey = (index: number) => `s${index}`;

/** One row per bucket with each series' tokens (`s0`…); unnamed ids fold into Other. */
export function buildBreakdownTrendRows(
  timeline: ReadonlyArray<UsageTimelineBucket>,
  series: ReadonlyArray<BreakdownPieEntry>,
  field: UsageBucketShareField,
): UsageTrendRow[] {
  const named = new Set(series.filter((entry) => entry.id !== "other").map((entry) => entry.id));
  return timeline.map((bucket) => {
    const shares = bucket[field] ?? [];
    const row: Record<string, number | string> = { bucketStart: bucket.bucketStart };
    series.forEach((entry, index) => {
      row[breakdownSeriesKey(index)] = shares
        .filter((share) => (entry.id === "other" ? !named.has(share.id) : share.id === entry.id))
        .reduce((total, share) => total + share.usedTokens, 0);
    });
    return row as UsageTrendRow;
  });
}

export type UsageBucketDetail = {
  readonly bucket: UsageTimelineBucket;
  readonly shareOfRange: number;
  readonly rank: number;
  readonly activeBuckets: number;
  readonly tokensPerTurn: number | null;
  readonly topProviderId: string | null;
  readonly topModelId: string | null;
};

export function describeUsageBucket(
  timeline: ReadonlyArray<UsageTimelineBucket>,
  bucketStart: string,
  totalTokens: number,
): UsageBucketDetail | null {
  const bucket = timeline.find((entry) => entry.bucketStart === bucketStart);
  if (!bucket) return null;
  const active = timeline.filter((entry) => entry.usedTokens > 0);
  return {
    bucket,
    shareOfRange: totalTokens > 0 ? bucket.usedTokens / totalTokens : 0,
    rank: active.filter((entry) => entry.usedTokens > bucket.usedTokens).length + 1,
    activeBuckets: active.length,
    tokensPerTurn: bucket.turnCount > 0 ? Math.round(bucket.usedTokens / bucket.turnCount) : null,
    topProviderId: bucket.providers?.[0]?.id ?? null,
    topModelId: bucket.models?.[0]?.id ?? null,
  };
}

/** Arrow-key stepping through the timeline; wraps at both ends, starts from an edge. */
export function stepUsageBucket(
  timeline: ReadonlyArray<UsageTimelineBucket>,
  selected: string | null,
  direction: 1 | -1,
): string | null {
  if (timeline.length === 0) return null;
  const index = timeline.findIndex((bucket) => bucket.bucketStart === selected);
  const next =
    index === -1
      ? direction === 1
        ? 0
        : timeline.length - 1
      : (index + direction + timeline.length) % timeline.length;
  return timeline[next]?.bucketStart ?? null;
}

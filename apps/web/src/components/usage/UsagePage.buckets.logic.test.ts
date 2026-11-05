import { describe, expect, it } from "vitest";
import type { ServerUsageBucket } from "@bigbud/contracts/server/usage.ts";

import {
  buildBreakdownTrendRows,
  describeUsageBucket,
  fillUsageTimeline,
  hasUsageBucketShares,
  stepUsageBucket,
} from "./UsagePage.buckets.logic";
import type { BreakdownPieEntry } from "./UsageBreakdownCard.pie.logic";

function bucket(bucketStart: string, usedTokens: number, extra: Partial<ServerUsageBucket> = {}) {
  return {
    bucketStart,
    usedTokens,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    turnCount: usedTokens > 0 ? 2 : 0,
    ...extra,
  } satisfies ServerUsageBucket;
}

describe("fillUsageTimeline", () => {
  it("fills every UTC hour of a 24h range, keeping server buckets in place", () => {
    const timeline = fillUsageTimeline({
      range: "24h",
      generatedAt: "2026-10-29T12:34:00.000Z",
      buckets: [bucket("2026-10-29T02:00:00.000Z", 50), bucket("2026-10-29T12:00:00.000Z", 5)],
    });
    expect(timeline).toHaveLength(25);
    expect(timeline[0]?.bucketStart).toBe("2026-10-28T12:00:00.000Z");
    expect(timeline.at(-1)).toMatchObject({
      bucketStart: "2026-10-29T12:00:00.000Z",
      empty: false,
    });
    expect(
      timeline.find((entry) => entry.bucketStart === "2026-10-29T02:00:00.000Z"),
    ).toMatchObject({ usedTokens: 50, empty: false });
    expect(timeline.filter((entry) => entry.empty)).toHaveLength(23);
    expect(timeline.reduce((total, entry) => total + entry.usedTokens, 0)).toBe(55);
  });

  it("fills days for 7d and months from the first bucket for all", () => {
    expect(
      fillUsageTimeline({
        range: "7d",
        generatedAt: "2026-10-29T08:00:00.000Z",
        buckets: [bucket("2026-10-25T00:00:00.000Z", 1)],
      }).map((entry) => entry.bucketStart.slice(0, 10)),
    ).toEqual([
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
    ]);
    expect(
      fillUsageTimeline({
        range: "all",
        generatedAt: "2026-10-29T08:00:00.000Z",
        buckets: [bucket("2026-07-01T00:00:00.000Z", 1)],
      }).map((entry) => entry.bucketStart.slice(0, 7)),
    ).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
  });

  it("returns nothing without usage so the empty state still shows", () => {
    expect(
      fillUsageTimeline({ range: "24h", generatedAt: "2026-10-29T08:00:00.000Z", buckets: [] }),
    ).toEqual([]);
  });
});

const series: BreakdownPieEntry[] = [
  { id: "claudeAgent", label: "Claude", usedTokens: 70, fill: "var(--chart-1)" },
  { id: "other", label: "Other", usedTokens: 30, fill: "var(--chart-5)" },
];

describe("buildBreakdownTrendRows", () => {
  it("gives each series its own tokens per bucket and folds unnamed ids into Other", () => {
    const timeline = fillUsageTimeline({
      range: "24h",
      generatedAt: "2026-10-29T01:10:00.000Z",
      buckets: [
        bucket("2026-10-29T01:00:00.000Z", 100, {
          providers: [
            { id: "claudeAgent", usedTokens: 70 },
            { id: "pi", usedTokens: 20 },
            { id: "cursor", usedTokens: 10 },
          ],
        }),
      ],
    });
    const rows = buildBreakdownTrendRows(timeline, series, "providers");
    expect(rows.at(-1)).toEqual({ bucketStart: "2026-10-29T01:00:00.000Z", s0: 70, s1: 30 });
    expect(rows[0]).toEqual({ bucketStart: rows[0]?.bucketStart, s0: 0, s1: 0 });
  });

  it("detects older servers that send buckets without a split", () => {
    const timeline = fillUsageTimeline({
      range: "24h",
      generatedAt: "2026-10-29T01:10:00.000Z",
      buckets: [bucket("2026-10-29T01:00:00.000Z", 100)],
    });
    expect(hasUsageBucketShares(timeline, "providers")).toBe(false);
    expect(hasUsageBucketShares([], "providers")).toBe(false);
  });
});

describe("bucket selection", () => {
  const timeline = fillUsageTimeline({
    range: "24h",
    generatedAt: "2026-10-29T03:10:00.000Z",
    buckets: [
      bucket("2026-10-29T01:00:00.000Z", 30, { models: [{ id: "opus", usedTokens: 30 }] }),
      bucket("2026-10-29T03:00:00.000Z", 70),
    ],
  });

  it("describes share, rank and per-turn cost for the selected bucket", () => {
    expect(describeUsageBucket(timeline, "2026-10-29T01:00:00.000Z", 100)).toMatchObject({
      shareOfRange: 0.3,
      rank: 2,
      activeBuckets: 2,
      tokensPerTurn: 15,
      topModelId: "opus",
      topProviderId: null,
    });
    expect(describeUsageBucket(timeline, "2026-10-29T02:00:00.000Z", 100)).toMatchObject({
      tokensPerTurn: null,
      rank: 3,
    });
    expect(describeUsageBucket(timeline, "missing", 100)).toBeNull();
  });

  it("steps with wrap-around and enters from the matching edge", () => {
    const first = timeline[0]!.bucketStart;
    const last = timeline.at(-1)!.bucketStart;
    expect(stepUsageBucket(timeline, null, 1)).toBe(first);
    expect(stepUsageBucket(timeline, null, -1)).toBe(last);
    expect(stepUsageBucket(timeline, last, 1)).toBe(first);
    expect(stepUsageBucket([], null, 1)).toBeNull();
  });
});

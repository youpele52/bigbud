import type { ServerUsageRange, ServerUsageSummaryResult } from "@bigbud/contracts/server/usage.ts";

import { Card, CardContent, CardHeader } from "../ui/card";
import { UsageBreakdownAreas } from "./UsageBreakdownCard.area";
import { buildBreakdownPieData } from "./UsageBreakdownCard.pie.logic";
import { UsageDonut, UsageLegendList } from "./UsageDonut";
import {
  buildBreakdownTrendRows,
  hasUsageBucketShares,
  type UsageBucketShareField,
  type UsageTimelineBucket,
} from "./UsagePage.buckets.logic";

export type UsageBreakdownView = "trend" | "split";

/** Providers or models, as a trend line over time or split into their share of the range. */
export function UsageBreakdownCard({
  entries,
  field,
  range,
  timeline,
  title,
  totalTokens,
  view,
}: {
  readonly entries: ServerUsageSummaryResult["providers"];
  readonly field: UsageBucketShareField;
  readonly range: ServerUsageRange;
  readonly timeline: ReadonlyArray<UsageTimelineBucket>;
  readonly title: string;
  readonly totalTokens: number;
  readonly view: UsageBreakdownView;
}) {
  // No "· Estimated"/"· Mixed" tags here; the page footer explains provenance once.
  const series = buildBreakdownPieData(entries);
  const slices = series.map((entry) => ({
    id: entry.id,
    label: entry.label,
    value: entry.usedTokens,
    fill: entry.fill,
  }));
  // Older servers send no per-bucket split, so the trend falls back to the split view.
  const showTrend = view === "trend" && hasUsageBucketShares(timeline, field);

  return (
    <Card>
      <CardHeader>
        <h3>{title}</h3>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No usage yet.</p>
        ) : showTrend ? (
          <div className="space-y-4">
            <UsageBreakdownAreas
              range={range}
              rows={buildBreakdownTrendRows(timeline, series, field)}
              series={series}
            />
            <div
              aria-label={`${title} legend`}
              className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground"
              role="list"
            >
              {slices.map((slice) => (
                <span key={slice.id} className="flex items-center gap-1.5" role="listitem">
                  <span className="size-2 rounded-full" style={{ backgroundColor: slice.fill }} />
                  {slice.label}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_14rem]">
            <UsageDonut size="lg" slices={slices} total={totalTokens} />
            <div className="flex min-w-0 flex-col justify-center">
              <UsageLegendList slices={slices} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

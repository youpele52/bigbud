import { useState } from "react";

import type { ServerUsageSummaryResult } from "@bigbud/contracts/server/usage.ts";

import { Card, CardContent, CardHeader } from "../ui/card";
import { UsageBucketInspector } from "./UsageBucketInspector";
import { UsageOverTimeChart } from "./UsageOverTimeChart";
import { describeUsageBucket, type UsageTimelineBucket } from "./UsagePage.buckets.logic";
import { usageBucketUnit } from "./UsagePage.format";
import { UsageTokenMixCard } from "./UsageTokenMixCard";

// Bucket split ids come from the same rows as the summary entries, so a label always exists.
function entryLabel(entries: ServerUsageSummaryResult["providers"], id: string | null) {
  if (!id) return null;
  return entries.find((entry) => entry.id === id)?.label ?? id;
}

/** Activity chart with a side pane: the range's token types, or the selected period's detail. */
export function UsageTokenUsageCard({
  summary,
  timeline,
}: {
  readonly summary: ServerUsageSummaryResult;
  readonly timeline: ReadonlyArray<UsageTimelineBucket>;
}) {
  // Keyed by bucket start, not index, so a refreshed summary keeps the same period selected.
  const [selected, setSelected] = useState<string | null>(null);
  const detail = selected
    ? describeUsageBucket(timeline, selected, summary.totals.usedTokens)
    : null;

  return (
    <Card className="grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <CardHeader>
          <h3>Tokens per {usageBucketUnit(summary.range)}</h3>
        </CardHeader>
        <CardContent>
          <UsageOverTimeChart
            onSelect={setSelected}
            range={summary.range}
            selected={detail ? selected : null}
            timeline={timeline}
          />
        </CardContent>
      </div>
      <aside
        aria-label="Activity details"
        aria-live="polite"
        className="border-t p-6 lg:border-t-0 lg:border-l"
      >
        {detail ? (
          <UsageBucketInspector
            detail={detail}
            modelLabel={entryLabel(summary.models, detail.topModelId)}
            onClear={() => setSelected(null)}
            providerLabel={entryLabel(summary.providers, detail.topProviderId)}
            range={summary.range}
          />
        ) : (
          <UsageTokenMixCard totals={summary.totals} />
        )}
      </aside>
    </Card>
  );
}

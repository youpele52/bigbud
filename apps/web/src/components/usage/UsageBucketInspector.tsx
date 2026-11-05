import type { ServerUsageRange } from "@bigbud/contracts/server/usage.ts";

import { Button } from "../ui/button";
import { usageSourceLabel } from "./UsageAccounting.logic";
import type { UsageBucketDetail } from "./UsagePage.buckets.logic";
import {
  formatBucketTooltipLabel,
  formatCompactNumber,
  formatSharePercent,
  usageBucketUnit,
} from "./UsagePage.format";

/** Selected-period detail shown in place of token types until the selection is cleared. */
export function UsageBucketInspector({
  detail,
  range,
  providerLabel,
  modelLabel,
  onClear,
}: {
  readonly detail: UsageBucketDetail;
  readonly range: ServerUsageRange;
  readonly providerLabel: string | null;
  readonly modelLabel: string | null;
  readonly onClear: () => void;
}) {
  const { bucket } = detail;
  const rows: ReadonlyArray<readonly [string, string | null]> = [
    ["Share of range", formatSharePercent(detail.shareOfRange)],
    ["Rank", `#${detail.rank} of ${detail.activeBuckets}`],
    ["Turns", bucket.turnCount.toLocaleString()],
    ["Per turn", detail.tokensPerTurn === null ? null : formatCompactNumber(detail.tokensPerTurn)],
    ["Source", usageSourceLabel(bucket.accounting) || "Reported"],
    ["Top provider", providerLabel],
    ["Top model", modelLabel],
  ];

  return (
    <section aria-label="Selected period" className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-normal text-muted-foreground">
            {formatBucketTooltipLabel(bucket.bucketStart, range)}
          </h3>
          <div className="text-2xl font-semibold text-foreground">
            {formatCompactNumber(bucket.usedTokens)}
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {bucket.usedTokens.toLocaleString()} tokens
          </div>
        </div>
        <Button aria-label="Back to token types" onClick={onClear} size="xs" variant="ghost">
          Clear
        </Button>
      </div>
      {bucket.usedTokens === 0 ? (
        <p className="text-sm text-muted-foreground">No usage in this {usageBucketUnit(range)}.</p>
      ) : (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-sm">
          {rows.flatMap(([label, value]) =>
            value === null
              ? []
              : [
                  <dt key={`${label}:dt`} className="text-muted-foreground">
                    {label}
                  </dt>,
                  <dd
                    key={`${label}:dd`}
                    className="min-w-0 truncate text-right text-foreground tabular-nums"
                    title={value}
                  >
                    {value}
                  </dd>,
                ],
          )}
        </dl>
      )}
    </section>
  );
}

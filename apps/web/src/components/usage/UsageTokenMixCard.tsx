import { type ServerUsageSummaryResult } from "@bigbud/contracts";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { disjointUsageMix } from "./UsageAccounting.logic";
import { UsageDonut, UsageLegendList } from "./UsageDonut";

const tokenMixChartConfig = {
  inputTokens: { color: "var(--chart-2)", label: "Input" },
  cacheReadTokens: { color: "var(--chart-1)", label: "Cache read" },
  cacheWriteTokens: { color: "var(--chart-5)", label: "Cache write" },
  outputTokens: { color: "var(--chart-3)", label: "Output" },
  unclassifiedTokens: { color: "var(--muted-foreground)", label: "Unsplit usage" },
} as const;

/** Token types for the whole range; sits in the Activity card's side pane. */
function UsageTokenMixCard({ totals }: { readonly totals: ServerUsageSummaryResult["totals"] }) {
  const slices = buildTokenMixData(totals);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  return (
    <section aria-label="Token types" className="space-y-4">
      <h3>Token types</h3>
      {slices.length === 0 ? (
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyTitle>No usage yet.</EmptyTitle>
            <EmptyDescription>No tokens recorded for this range.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <UsageDonut slices={slices} total={total} />
          <UsageLegendList slices={slices} />
        </>
      )}
    </section>
  );
}

function buildTokenMixData(totals: ServerUsageSummaryResult["totals"]) {
  const mix = disjointUsageMix(totals);
  return Object.entries(tokenMixChartConfig)
    .map(([id, config]) => ({
      id,
      label: config.label,
      value: mix[id as keyof typeof mix],
      fill: config.color,
    }))
    .filter((entry) => entry.value > 0);
}

export { UsageTokenMixCard };

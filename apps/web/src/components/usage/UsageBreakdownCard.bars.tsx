import type { ServerUsageSummaryResult } from "@bigbud/contracts";

export function UsageBreakdownBars({
  entries,
  title,
  totalTokens,
}: {
  readonly entries: ServerUsageSummaryResult["providers"];
  readonly title: string;
  readonly totalTokens: number;
}) {
  return (
    <div className="space-y-3">
      {entries.slice(0, 8).map((entry) => {
        const ratio = totalTokens > 0 ? Math.max(2, (entry.usedTokens / totalTokens) * 100) : 0;
        return (
          <div key={`${title}:${entry.id}`} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-foreground">{entry.label}</span>
              <span className="shrink-0 text-muted-foreground">
                {entry.usedTokens.toLocaleString()}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted/60">
              <div
                className="h-2 rounded-full bg-[var(--chart-2)]"
                style={{ width: `${ratio}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

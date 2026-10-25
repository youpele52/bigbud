import type { ServerUsageSummaryResult } from "@bigbud/contracts";

import { Card, CardContent, CardHeader } from "../ui/card";
import { UsageBreakdownBars } from "./UsageBreakdownCard.bars";
import { UsageBreakdownPie } from "./UsageBreakdownCard.pie";
import { usageSourceLabel } from "./UsageAccounting.logic";

export type UsageBreakdownView = "bar" | "pie";

export function UsageBreakdownCard({
  entries,
  title,
  totalTokens,
  view,
}: {
  readonly entries: ServerUsageSummaryResult["providers"];
  readonly title: string;
  readonly totalTokens: number;
  readonly view: UsageBreakdownView;
}) {
  const labeledEntries = entries.map((entry) => ({
    ...entry,
    label: `${entry.label}${usageSourceLabel(entry.accounting) ? ` · ${usageSourceLabel(entry.accounting)}` : ""}`,
  }));
  return (
    <Card>
      <CardHeader>
        <h3>{title}</h3>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No usage yet.</p>
        ) : view === "pie" ? (
          <UsageBreakdownPie entries={labeledEntries} totalTokens={totalTokens} />
        ) : (
          <UsageBreakdownBars entries={labeledEntries} totalTokens={totalTokens} title={title} />
        )}
      </CardContent>
    </Card>
  );
}

import type { ServerUsageSummaryResult } from "@bigbud/contracts";

import { Card, CardContent, CardHeader } from "../ui/card";
import { UsageBreakdownBars } from "./UsageBreakdownCard.bars";
import { UsageBreakdownPie } from "./UsageBreakdownCard.pie";

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
  return (
    <Card>
      <CardHeader>
        <h3>{title}</h3>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No usage yet.</p>
        ) : view === "pie" ? (
          <UsageBreakdownPie entries={entries} totalTokens={totalTokens} />
        ) : (
          <UsageBreakdownBars entries={entries} totalTokens={totalTokens} title={title} />
        )}
      </CardContent>
    </Card>
  );
}

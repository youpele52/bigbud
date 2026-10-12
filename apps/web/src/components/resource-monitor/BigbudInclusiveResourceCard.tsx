import type { MonitorAppResources } from "@bigbud/contracts/system-monitor/types";
import type { AppHistory } from "~/stores/resource-monitor/resourceMonitor.appHistory";
import { Card, CardContent } from "../ui/card";
import { appMetricValue } from "./BigbudResourceView.logic";
import { formatBytes, formatPercent } from "./resourceMonitor.format";
import { ResourceUsageTrend } from "./ResourceUsageTrend";

/** Inclusive usage includes the core app and its observed agent/tool subprocesses. */
export function BigbudInclusiveResourceCard({
  app,
  history,
  large = false,
}: {
  app: MonitorAppResources | undefined;
  history: AppHistory;
  large?: boolean;
}) {
  const measured = app && !app.incomplete;
  return (
    <Card
      className={`min-w-0 gap-0 border-emerald-500/20 bg-emerald-500/5 py-4 ${large ? "min-h-72" : "min-h-60"}`}
    >
      <CardContent className="flex h-full flex-1 flex-col gap-4 px-4 py-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Including agents/tools</h3>
          <span className="rounded-full border border-emerald-500/15 bg-background/60 px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
            {app?.inclusive.processCount ?? "—"} processes
          </span>
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <ResourceUsageTrend
            label="CPU"
            value={appMetricValue(app?.inclusive.cpuPercent, formatPercent)}
            history={measured ? history.inclusiveCpu : []}
            color="var(--chart-1)"
            formatValue={formatPercent}
            large={large}
          />
          <ResourceUsageTrend
            label="Memory"
            value={appMetricValue(app?.inclusive.residentBytes, formatBytes)}
            history={measured ? history.inclusiveMemory : []}
            color="var(--chart-2)"
            formatValue={formatBytes}
            large={large}
          />
        </div>
        <p className="mt-auto text-xs leading-relaxed text-muted-foreground">
          Core bigbud + observed agent/tool subprocesses
        </p>
      </CardContent>
    </Card>
  );
}

import type { MonitorAppResources } from "@bigbud/contracts/system-monitor/types";
import type { AppHistory } from "~/stores/resource-monitor/resourceMonitor.appHistory";
import { Card, CardContent } from "../ui/card";
import { appMetricValue } from "./BigbudResourceView.logic";
import { formatBytes, formatPercent } from "./resourceMonitor.format";
import { ResourceUsageTrend } from "./ResourceUsageTrend";
import { ResourceMetricBadge } from "./ResourceMetricBadge";
import { isLoadingStatus } from "../common/CenteredStatus.logic";

/** Inclusive usage includes the core app and its observed agent/tool subprocesses. */
export function BigbudInclusiveResourceCard({
  app,
  history,
  large = false,
  pending = false,
}: {
  app: MonitorAppResources | undefined;
  history: AppHistory;
  large?: boolean;
  pending?: boolean;
}) {
  const measured = app && !app.incomplete;
  return (
    <Card
      className={`min-w-0 gap-0 border-emerald-500/20 bg-emerald-500/5 py-4 ${large ? "min-h-72" : "min-h-60"}`}
    >
      <CardContent className="flex h-full flex-1 flex-col gap-4 px-4 py-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Including agents/tools</h3>
          <ResourceMetricBadge className="border-emerald-500/15">
            {app?.inclusive.processCount ?? "—"} processes
          </ResourceMetricBadge>
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <ResourceUsageTrend
            label="CPU"
            value={appMetricValue(app?.inclusive.cpuPercent, formatPercent)}
            history={measured ? history.inclusiveCpu : []}
            color="var(--chart-1)"
            formatValue={formatPercent}
            large={large}
            loading={
              pending ||
              Boolean(
                measured &&
                (app.inclusive.cpuPercent?.status === "ready" ||
                  isLoadingStatus(app.inclusive.cpuPercent?.status ?? "unavailable")),
              )
            }
          />
          <ResourceUsageTrend
            label="Memory"
            value={appMetricValue(app?.inclusive.residentBytes, formatBytes)}
            history={measured ? history.inclusiveMemory : []}
            color="var(--chart-2)"
            formatValue={formatBytes}
            large={large}
            loading={
              pending ||
              Boolean(
                measured &&
                (app.inclusive.residentBytes?.status === "ready" ||
                  isLoadingStatus(app.inclusive.residentBytes?.status ?? "unavailable")),
              )
            }
          />
        </div>
        <p className="mt-auto text-xs leading-relaxed text-muted-foreground">
          Core bigbud + observed agent/tool subprocesses
        </p>
      </CardContent>
    </Card>
  );
}

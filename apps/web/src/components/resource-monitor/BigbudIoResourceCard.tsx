import type { MonitorAppResources } from "@bigbud/contracts/system-monitor/types";
import type { HistoryPoint } from "~/stores/resource-monitor/resourceMonitor.store";
import { Card, CardContent } from "../ui/card";
import { appMetricValue } from "./BigbudResourceView.logic";
import { ResourceMetricHistory } from "./ResourceMetricHistory";
import { ResourceTransferRates } from "./ResourceTransferRates";
import { formatRate } from "./resourceMonitor.format";

/** Display process I/O using the same direction readings and mirrored graph as Network. */
export function BigbudIoResourceCard({
  app,
  label,
  history,
  large = false,
}: {
  app: MonitorAppResources | undefined;
  label: string;
  history: HistoryPoint[];
  large?: boolean;
}) {
  const points = app && !app.incomplete ? history : [];
  return (
    <Card className={`min-w-0 gap-0 py-4 ${large ? "min-h-72" : "min-h-60"}`}>
      <CardContent className="flex h-full flex-1 flex-col gap-4 px-4 py-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{label}</h3>
          <span className="rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
            <span className="font-medium text-foreground">{app?.core.processCount ?? "—"}</span>{" "}
            core processes
          </span>
        </div>
        <div className="space-y-2">
          <ResourceTransferRates
            kind="io"
            incoming={appMetricValue(app?.core.readBytesPerSecond, formatRate)}
            outgoing={appMetricValue(app?.core.writtenBytesPerSecond, formatRate)}
          />
          {points.length > 1 ? (
            <ResourceMetricHistory
              metric={{
                label,
                value: "",
                status: "ready",
                history: points,
                historyStyle: "io",
                historyValueFormatter: formatRate,
              }}
              large={large}
            />
          ) : (
            <p
              className={`flex items-center justify-center text-xs text-muted-foreground ${large ? "h-28" : "h-12"}`}
            >
              {app && !app.incomplete ? "Waiting for I/O history…" : "Measurements unavailable"}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

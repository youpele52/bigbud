import type { MonitorAppResources } from "@bigbud/contracts/system-monitor/types";
import type { HistoryPoint } from "~/stores/resource-monitor/resourceMonitor.store";
import { Card, CardContent } from "../ui/card";
import { appMetricValue } from "./BigbudResourceView.logic";
import { ResourceMetricHistory } from "./ResourceMetricHistory";
import { ResourceTransferRates } from "./ResourceTransferRates";
import { formatRate } from "./resourceMonitor.format";
import { ResourceMetricBadge } from "./ResourceMetricBadge";
import { CenteredStatus } from "../common/CenteredStatus";
import { isLoadingStatus } from "../common/CenteredStatus.logic";

/** Display process I/O using the same direction readings and mirrored graph as Network. */
export function BigbudIoResourceCard({
  app,
  label,
  history,
  large = false,
  pending = false,
}: {
  app: MonitorAppResources | undefined;
  label: string;
  history: HistoryPoint[];
  large?: boolean;
  pending?: boolean;
}) {
  const points = app && !app.incomplete ? history : [];
  const waiting =
    pending ||
    Boolean(
      app &&
      !app.incomplete &&
      [app.core.readBytesPerSecond, app.core.writtenBytesPerSecond].some(
        (metric) => metric?.status === "ready" || isLoadingStatus(metric?.status ?? "unavailable"),
      ),
    );
  return (
    <Card className={`min-w-0 gap-0 py-4 ${large ? "min-h-72" : "min-h-60"}`}>
      <CardContent className="flex h-full flex-1 flex-col gap-4 px-4 py-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{label}</h3>
          <ResourceMetricBadge>
            <span className="font-medium text-foreground">{app?.core.processCount ?? "—"}</span>{" "}
            core processes
          </ResourceMetricBadge>
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
            <CenteredStatus loading={waiting} className={large ? "h-28" : "h-12"}>
              {waiting ? "Waiting for I/O history" : "Measurements unavailable"}
            </CenteredStatus>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

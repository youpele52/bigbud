import type { MonitorNetworkInterface } from "@bigbud/contracts/system-monitor/types";
import type { ReactNode } from "react";
import type { HistoryPoint } from "~/stores/resource-monitor/resourceMonitor.store";
import { readyTransferValue } from "~/stores/resource-monitor/resourceMonitor.history";
import { cn } from "~/lib/utils";
import { CenteredStatus } from "../common/CenteredStatus";
import { isLoadingStatus } from "../common/CenteredStatus.logic";
import { ResourceTransferRates } from "./ResourceTransferRates";
import { ResourceMetricHistory } from "./ResourceMetricHistory";
import { ResourceNetworkInterfaceDetails } from "./ResourceNetworkInterfaceDetails";
import { interfaceLinkText, interfaceMetricText } from "./ResourceNetworkInterface.logic";
import { formatBytes, formatRate } from "./resourceMonitor.format";

/** A stable inset interface card mirrors the main Network design without activity-based grouping. */
export function ResourceNetworkInterfaceContent({
  item,
  history,
  showHistory,
  current,
  expanded = false,
  headerAction,
}: {
  item: MonitorNetworkInterface;
  history: HistoryPoint[];
  showHistory: boolean;
  current: boolean;
  expanded?: boolean;
  headerAction?: ReactNode;
}) {
  const incoming = current ? readyTransferValue(item.receivedBytesPerSecond) : undefined;
  const outgoing = current ? readyTransferValue(item.transmittedBytesPerSecond) : undefined;
  const link = interfaceLinkText(item.linkState, current);
  const linkState =
    current && item.linkState?.status === "ready" ? item.linkState.value : undefined;
  const waiting =
    current &&
    [item.receivedBytesPerSecond, item.transmittedBytesPerSecond].some(
      (metric) =>
        readyTransferValue(metric) !== undefined ||
        isLoadingStatus(metric?.status ?? "unavailable"),
    );
  return (
    <section
      role="region"
      aria-label={`${item.name}${expanded ? " expanded" : ""} network interface`}
      className={cn(
        "@container min-w-0 space-y-3",
        !expanded && "rounded-xl border border-border/60 bg-background/30 p-3",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-center justify-between gap-2",
          expanded && "pr-8",
        )}
      >
        <h3 className="min-w-0 break-words text-sm font-medium">{item.name}</h3>
        <div className="flex shrink-0 items-center gap-2">
          <span
            role="img"
            aria-label={link}
            title={link}
            className={cn(
              "size-2 shrink-0 rounded-full",
              linkState === "up"
                ? "bg-success"
                : linkState === "down"
                  ? "bg-destructive"
                  : "bg-muted-foreground",
            )}
          />
          {headerAction}
        </div>
      </div>
      <ResourceTransferRates
        kind="network"
        incoming={formatRate(incoming)}
        outgoing={formatRate(outgoing)}
        centered
      />
      {showHistory ? (
        <div className={cn("min-w-0", expanded ? "h-64" : "h-20")} data-slot="interface-history">
          {current && (incoming !== undefined || outgoing !== undefined) && history.length > 1 ? (
            <ResourceMetricHistory
              fill
              metric={{
                label: `${item.name} network`,
                value: "",
                status: "ready",
                history,
                historyStyle: "network",
                historyValueFormatter: formatRate,
              }}
            />
          ) : (
            <CenteredStatus loading={waiting} className="h-full">
              {waiting ? "Waiting for network history" : "Network measurements unavailable"}
            </CenteredStatus>
          )}
        </div>
      ) : null}
      <dl className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
        <div className="min-w-0">
          <dt>Downloaded total</dt>
          <dd className="break-words tabular-nums">
            {interfaceMetricText(item.receivedTotalBytes, formatBytes)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt>Uploaded total</dt>
          <dd className="break-words tabular-nums">
            {interfaceMetricText(item.transmittedTotalBytes, formatBytes)}
          </dd>
        </div>
      </dl>
      <ResourceNetworkInterfaceDetails item={item} expanded={expanded} />
    </section>
  );
}

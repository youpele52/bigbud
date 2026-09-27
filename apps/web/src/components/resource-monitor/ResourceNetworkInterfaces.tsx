import type {
  MonitorMetric,
  MonitorNetworkInterface,
  MonitorTextField,
} from "@bigbud/contracts/system-monitor/types";

import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { formatBytes } from "./resourceMonitor.format";

function showMetric(metric: MonitorMetric | undefined, format: (value: number) => string): string {
  return metric?.status === "ready" ? format(metric.value) : (metric?.status ?? "unavailable");
}

function showLinkState(field: MonitorTextField | undefined): string {
  return field?.status === "ready" ? field.value : (field?.status ?? "unavailable");
}

export function ResourceNetworkInterfaces({
  interfaces,
}: {
  interfaces: readonly MonitorNetworkInterface[];
}) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Network interfaces</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-4 text-sm">
        {interfaces.length ? (
          interfaces.map((item) => (
            <div key={item.name} className="rounded-md border p-2">
              <p className="truncate font-medium">{item.name}</p>
              <p className="text-xs text-muted-foreground">
                Link: {showLinkState(item.linkState)} · MTU:{" "}
                {showMetric(item.mtuBytes, (value) => `${value} B`)}
              </p>
              <p className="text-xs text-muted-foreground">
                Received{" "}
                {showMetric(item.receivedBytesPerSecond, (value) => `${formatBytes(value)}/s`)} ·
                Sent{" "}
                {showMetric(item.transmittedBytesPerSecond, (value) => `${formatBytes(value)}/s`)}
              </p>
              <p className="text-xs text-muted-foreground">
                Totals: ↓ {showMetric(item.receivedTotalBytes, formatBytes)} · ↑{" "}
                {showMetric(item.transmittedTotalBytes, formatBytes)}
              </p>
              <p className="text-xs text-muted-foreground">
                Errors: receive {showMetric(item.receiveErrors, String)} · transmit{" "}
                {showMetric(item.transmitErrors, String)}
              </p>
              <p className="text-xs text-muted-foreground">
                Packets: ↓ {showMetric(item.receivedPackets, String)} · ↑{" "}
                {showMetric(item.transmittedPackets, String)}
              </p>
            </div>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">No interface details available</p>
        )}
      </CardContent>
    </Card>
  );
}

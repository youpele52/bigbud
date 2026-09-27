import type { MonitorMetric, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";

import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { formatDecimal } from "./resourceMonitor.format";

function value(metric: MonitorMetric | undefined, format: (number: number) => string): string {
  return metric?.status === "ready" ? format(metric.value) : (metric?.status ?? "unavailable");
}

export function ResourceHostExtras({ snapshot }: { snapshot: MonitorSnapshot | null }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Additional host details</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 px-4 text-sm sm:grid-cols-2">
        <p>Kernel: {snapshot?.kernelVersion || "unavailable"}</p>
        <p>
          Booted:{" "}
          {value(snapshot?.bootTimeSeconds, (seconds) => new Date(seconds * 1000).toLocaleString())}
        </p>
        <p>Physical cores: {value(snapshot?.physicalCores, String)}</p>
        <p>CPU: {snapshot?.cpuBrand || "unavailable"}</p>
        <p>
          CPU frequency: {value(snapshot?.cpuFrequencyMhz, (mhz) => `${formatDecimal(mhz)} MHz`)}
        </p>
        <p>
          Load average (1 / 5 / 15 min):{" "}
          {[
            value(snapshot?.loadAverageOne, formatDecimal),
            value(snapshot?.loadAverageFive, formatDecimal),
            value(snapshot?.loadAverageFifteen, formatDecimal),
          ].join(" / ")}
        </p>
      </CardContent>
    </Card>
  );
}

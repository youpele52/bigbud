import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import { Button } from "../ui/button";
import { ResourceCollectionStatus } from "./ResourceCollectionStatus";
import { ResourceMetricCard } from "./ResourceMetricCard";
import { WidgetPreferences } from "./WidgetPreferences";
import { displayWidget, hasTemperature } from "./resourceMonitor.display";
import { useResourceMonitor } from "./useResourceMonitor";
import { retryResourceMonitor } from "~/stores/resource-monitor/resourceMonitor.store";
import { useResourceWidgetPreferences } from "~/stores/resource-monitor/resourceMonitorPreferences.store";

export function SystemPanel({ visible }: { visible: boolean }) {
  const widgets = useResourceWidgetPreferences((state) => state.visible);
  const { snapshot, history, connection, reason, collectionStatus } = useResourceMonitor(
    visible,
    false,
    widgets.includes("temperature"),
  );
  const temperatureSupported = hasTemperature(snapshot);
  const hostname = snapshot?.hostname || "Desktop computer";

  return (
    <div className="space-y-4 p-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">System</h2>
          <p className="truncate text-xs text-muted-foreground" title={hostname}>
            {hostname} · desktop host
          </p>
          {snapshot?.osName || snapshot?.architecture ? (
            <p className="truncate text-xs text-muted-foreground">
              {[snapshot.osName, snapshot.osVersion, snapshot.architecture]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </div>
        <WidgetPreferences />
      </div>
      {connection !== "connected" ? (
        <div
          role="status"
          className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground"
        >
          <p>
            {connection === "connecting"
              ? "Connecting to this computer’s Resource monitor…"
              : `Resource monitor unavailable${reason ? `: ${reason}` : ""}`}
          </p>
          {connection === "unavailable" ? (
            <Button
              size="xs"
              variant="outline"
              className="mt-2"
              onClick={() => void retryResourceMonitor()}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      {connection === "connected" ? (
        <ResourceCollectionStatus
          status={collectionStatus}
          onRetry={() => void retryResourceMonitor()}
        />
      ) : null}
      {snapshot?.summaryStatus && snapshot.summaryStatus !== "ready" ? (
        <p role="status" className="text-xs capitalize text-amber-600">
          Resource summary: {snapshot.summaryStatus.replaceAll("_", " ")}
        </p>
      ) : null}
      <div className="grid gap-2">
        {widgets
          .filter((widget) => widget !== "temperature" || temperatureSupported || !snapshot)
          .map((widget) => {
            const metric = displayWidget(snapshot, widget);
            if (widget === "cpu") metric.history = history.cpu;
            if (widget === "memory") metric.history = history.memory;
            if (widget === "network") metric.history = history.network;
            return <ResourceMetricCard key={widget} metric={metric} />;
          })}
        {widgets.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            No widgets selected. Use Customize System widgets to add one.
          </p>
        ) : null}
        {widgets.includes("temperature") && snapshot && !temperatureSupported ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            Temperature is unavailable on this computer.
          </p>
        ) : null}
      </div>
      <Link
        to="/resource-monitor"
        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        Open Resource monitor <ArrowRightIcon className="size-3.5" />
      </Link>
    </div>
  );
}

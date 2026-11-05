import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import {
  STANDALONE_PAGE_SCROLL_CLASS,
  STANDALONE_PAGE_WIDTH_CLASS,
} from "../standalone/StandalonePageContent";
import { ResourceConnectionStatus } from "./ResourceConnectionStatus";
import { ResourceCollectionStatus } from "./ResourceCollectionStatus";
import { ResourceMetricCard } from "./ResourceMetricCard";
import { WidgetPreferences } from "./WidgetPreferences";
import { displayWidget, hasTemperature } from "./resourceMonitor.display";
import { useResourceMonitor } from "./useResourceMonitor";
import { retryResourceMonitor } from "~/stores/resource-monitor/resourceMonitor.store";
import {
  RESOURCE_WIDGETS,
  useResourceWidgetPreferences,
} from "~/stores/resource-monitor/resourceMonitorPreferences.store";
import { useResourceDetailPreferences } from "~/stores/resource-monitor/resourceMonitorDetails.store";
import { MonitorScopeToggle, type MonitorScope } from "./MonitorScopeToggle";
import { BigbudResourceView } from "./BigbudResourceView";
import { CenteredStatus } from "../common/CenteredStatus";
import { isLoadingStatus } from "../common/CenteredStatus.logic";
import { useConnectedSshMonitorProjects } from "./useConnectedSshMonitorProjects";
import { availableMonitorScope, connectedRemoteMonitorScopes } from "./monitorRemoteScopes";
import { useRemoteMonitor } from "./useRemoteMonitor";
import { useEffect } from "react";

export function SystemPanel({ visible }: { visible: boolean }) {
  const [scope, setScope] = useState<MonitorScope>("system");
  const projects = useConnectedSshMonitorProjects(visible);
  const remotes = connectedRemoteMonitorScopes(projects);
  const selected = remotes.find((entry) => entry.scope === scope);
  const activeScope = availableMonitorScope(scope, remotes);
  useEffect(() => {
    if (activeScope !== scope) setScope("system");
  }, [activeScope, scope]);
  const remote = useRemoteMonitor(
    visible ? (selected?.target ?? null) : null,
    selected?.scope.slice(4) ?? null,
  );
  const widgets = useResourceWidgetPreferences((state) => state.visible);
  const orderedWidgets = RESOURCE_WIDGETS.filter((widget) => widgets.includes(widget));
  const showIpAddress = useResourceDetailPreferences((state) =>
    state.visible.includes("ipAddress"),
  );
  const local = useResourceMonitor(
    visible && activeScope === "system",
    false,
    widgets.includes("temperature"),
  );
  const { snapshot, history, connection, reason, collectionStatus } = selected
    ? {
        ...local,
        snapshot: remote?.snapshot ?? null,
        history: remote?.history ?? { cpu: [], memory: [], network: [] },
        connection: remote?.connection ?? "connecting",
        reason: remote?.reason ?? null,
        collectionStatus: null,
      }
    : local;
  const temperatureSupported = hasTemperature(snapshot);
  const hostname = snapshot?.hostname || selected?.name || "Desktop computer";

  return (
    <div className={STANDALONE_PAGE_SCROLL_CLASS}>
      <div className={cn("@container space-y-4 p-4 text-sm", STANDALONE_PAGE_WIDTH_CLASS)}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">System Monitor</h2>
            {showIpAddress ? (
              <p className="truncate text-xs text-muted-foreground" title={hostname}>
                {hostname} · {selected ? "SSH host" : "desktop host"}
              </p>
            ) : null}
            {snapshot?.osName || snapshot?.architecture ? (
              <p className="truncate text-xs text-muted-foreground">
                {[snapshot.osName, snapshot.osVersion, snapshot.architecture]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
          {activeScope !== "bigbud" ? <WidgetPreferences /> : null}
        </div>
        <MonitorScopeToggle scope={activeScope} onScopeChange={setScope} remotes={remotes} />
        {activeScope === "bigbud" ? (
          <BigbudResourceView visible={visible} large />
        ) : (
          <>
            {connection !== "connected" ? (
              <ResourceConnectionStatus
                connecting={connection === "connecting"}
                reason={reason}
                {...(selected ? { remoteName: selected.name } : {})}
              />
            ) : null}
            {connection === "connected" && !selected ? (
              <ResourceCollectionStatus
                status={collectionStatus}
                onRetry={() => void retryResourceMonitor()}
              />
            ) : null}
            {snapshot?.summaryStatus && snapshot.summaryStatus !== "ready" ? (
              <CenteredStatus
                loading={connection === "connected" && isLoadingStatus(snapshot.summaryStatus)}
                className="capitalize"
              >
                Resource summary: {snapshot.summaryStatus.replaceAll("_", " ")}
              </CenteredStatus>
            ) : null}
            <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
              {orderedWidgets
                .filter((widget) => widget !== "temperature" || temperatureSupported || !snapshot)
                .map((widget) => {
                  const metric = displayWidget(snapshot, widget);
                  if (widget === "cpu") metric.history = history.cpu;
                  if (widget === "memory")
                    metric.history =
                      connection === "connected" &&
                      (snapshot?.summaryStatus === "ready" ||
                        (Boolean(selected) && snapshot?.summaryStatus === "partial"))
                        ? history.memory
                        : [];
                  if (widget === "network") metric.history = history.network;
                  return (
                    <ResourceMetricCard
                      key={widget}
                      metric={metric}
                      loading={
                        connection !== "unavailable" &&
                        collectionStatus?.state !== "failed" &&
                        isLoadingStatus(metric.status)
                      }
                    />
                  );
                })}
              {orderedWidgets.length === 0 ? (
                <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                  No widgets selected. Use Customize System widgets to add one.
                </p>
              ) : null}
              {widgets.includes("temperature") && snapshot && !temperatureSupported ? (
                <CenteredStatus className="rounded-md border border-dashed p-3">
                  Temperature is unavailable on this computer.
                </CenteredStatus>
              ) : null}
            </div>
          </>
        )}
        <Link
          to="/system-monitor"
          search={{ monitorScope: activeScope }}
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {activeScope === "bigbud"
            ? "Open bigbud Monitor"
            : selected
              ? `Open ${selected.name} Monitor`
              : "Open System Monitor"}{" "}
          <ArrowRightIcon className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}

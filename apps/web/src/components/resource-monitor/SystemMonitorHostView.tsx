import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { useMemo } from "react";

import { retryResourceMonitor } from "~/stores/resource-monitor/resourceMonitor.store";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ProcessTable, type DisplayProcess } from "./ProcessTable";
import { ResourceMetricCard } from "./ResourceMetricCard";
import { CenteredStatus } from "../common/CenteredStatus";
import { isLoadingStatus } from "../common/CenteredStatus.logic";
import { ResourceCollectionStatus } from "./ResourceCollectionStatus";
import { ResourceListLimitWarning } from "./ResourceListLimitWarning";
import { ResourceHostExtras } from "./ResourceHostExtras";
import { ResourceDetailPreferences } from "./ResourceDetailPreferences";
import { ResourceNetworkInterfaces } from "./ResourceNetworkInterfaces";
import { ResourceDisks } from "./ResourceDisks";
import { ResourceCpuCores } from "./ResourceCpuCores";
import { displayWidget } from "./resourceMonitor.display";
import {
  formatBytes,
  formatDecimal,
  formatPercent,
  formatTemperature,
} from "./resourceMonitor.format";
import { useProcessPage } from "./useProcessPage";
import { useResourceMonitor } from "./useResourceMonitor";
import { useResourceDetailPreferences } from "~/stores/resource-monitor/resourceMonitorDetails.store";

function criticalTemperature(snapshot: MonitorSnapshot, name: string): string | null {
  const metric = snapshot.criticalTemperaturesCelsius?.find((entry) => entry.name === name)?.metric;
  if (!metric) return null;
  return metric.status === "ready" ? formatTemperature(metric.value) : metric.status;
}

export function SystemMonitorHostView() {
  const details = useResourceDetailPreferences((state) => state.visible);
  const show = (detail: (typeof details)[number]) => details.includes(detail);
  const { snapshot, history, diskHistory, connection, reason, collectionStatus } =
    useResourceMonitor(true, show("processes"), show("temperatures"));
  const processes = useProcessPage(
    show("processes") &&
      connection === "connected" &&
      (snapshot?.processStatus === "ready" || snapshot?.processStatus === "warming"),
  );
  const rows = useMemo<DisplayProcess[]>(
    () =>
      (processes.page?.rows ?? []).slice(0, 100).map((row) => ({
        pid: row.pid,
        name: row.name,
        status: row.status,
        cpu: row.cpuPercent?.status === "ready" ? formatPercent(row.cpuPercent.value) : "—",
        memory: formatBytes(row.residentBytes),
        startTime: String(row.startTimeSeconds),
        details: [
          ["Started", new Date(row.startTimeSeconds * 1000).toLocaleString()],
          ["Parent PID", row.parentPid === undefined ? "—" : String(row.parentPid)],
          ["Runtime", `${formatDecimal(row.runTimeSeconds)} s`],
          ["Virtual memory", formatBytes(row.virtualBytes)],
          ["Disk read", formatBytes(row.diskReadBytes)],
          ["Disk written", formatBytes(row.diskWrittenBytes)],
        ],
      })),
    [processes.page],
  );

  const cpu = displayWidget(snapshot, "cpu");
  cpu.history = history.cpu;
  const memory = displayWidget(snapshot, "memory");
  memory.history =
    connection === "connected" && snapshot?.summaryStatus === "ready" ? history.memory : [];
  const disk = displayWidget(snapshot, "disk");
  const network = displayWidget(snapshot, "network");
  network.history = history.network;
  const temperature = displayWidget(snapshot, "temperature");

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">System Monitor</h1>
          {show("ipAddress") ? (
            <p
              className="max-w-full truncate text-sm text-muted-foreground"
              title={snapshot?.hostname || undefined}
            >
              {snapshot?.hostname || "Desktop computer"} · desktop host
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {[snapshot?.osName, snapshot?.osVersion, snapshot?.architecture]
              .filter(Boolean)
              .join(" · ") || "OS details unavailable"}
          </p>
        </div>
        <ResourceDetailPreferences />
      </div>
      {connection !== "connected" ? (
        <CenteredStatus
          loading={connection === "connecting"}
          className="rounded-md border bg-muted/30 p-4 text-sm"
        >
          <p>
            {connection === "connecting"
              ? "Connecting to this computer’s System Monitor"
              : `System Monitor unavailable${reason ? `: ${reason}` : ""}`}
          </p>
          {connection === "unavailable" ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void retryResourceMonitor()}
            >
              Retry
            </Button>
          ) : null}
        </CenteredStatus>
      ) : null}
      {connection === "connected" ? (
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
      {snapshot &&
      (snapshot.perCoreTruncated ||
        snapshot.disksTruncated ||
        snapshot.interfacesTruncated ||
        snapshot.sensorsTruncated) ? (
        <ResourceListLimitWarning />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {[cpu, memory, disk, network].map((metric) => (
          <ResourceMetricCard
            key={metric.label}
            metric={metric}
            large
            loading={
              connection !== "unavailable" &&
              collectionStatus?.state !== "failed" &&
              isLoadingStatus(metric.status)
            }
          />
        ))}
      </div>
      {show("hostDetails") ? (
        <Card className="gap-2 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Host details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 px-4 text-sm sm:grid-cols-2">
            <p>
              OS:{" "}
              {[snapshot?.osName, snapshot?.osVersion].filter(Boolean).join(" ") || "Unavailable"}
            </p>
            <p>Architecture: {snapshot?.architecture || "Unavailable"}</p>
            <p>
              Logical cores:{" "}
              {snapshot?.logicalCores?.status === "ready"
                ? snapshot.logicalCores.value
                : (snapshot?.logicalCores?.status ?? "Unavailable")}
            </p>
            <p>
              Uptime:{" "}
              {snapshot?.uptimeSeconds?.status === "ready"
                ? `${formatDecimal(snapshot.uptimeSeconds.value / 3600)} hours`
                : (snapshot?.uptimeSeconds?.status ?? "Unavailable")}
            </p>
          </CardContent>
        </Card>
      ) : null}
      {show("hostExtras") ? <ResourceHostExtras snapshot={snapshot} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {show("disks") ? (
          <ResourceDisks
            snapshot={snapshot}
            history={diskHistory}
            active={
              connection === "connected" &&
              snapshot?.summaryStatus === "ready" &&
              (!collectionStatus || collectionStatus.state === "healthy")
            }
            loading={
              connection === "connecting" ||
              (connection === "connected" &&
                collectionStatus?.state !== "failed" &&
                (!snapshot || isLoadingStatus(snapshot.summaryStatus)))
            }
          />
        ) : null}
        {show("interfaces") ? (
          <ResourceNetworkInterfaces interfaces={snapshot?.interfaces ?? []} />
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {show("cores") ? (
          <ResourceCpuCores
            cores={snapshot?.perCorePercent ?? []}
            active={
              connection === "connected" &&
              snapshot?.summaryStatus === "ready" &&
              (!collectionStatus || collectionStatus.state === "healthy")
            }
            loading={
              connection === "connecting" ||
              (connection === "connected" &&
                collectionStatus?.state !== "failed" &&
                (!snapshot ||
                  snapshot.summaryStatus === "ready" ||
                  isLoadingStatus(snapshot.summaryStatus)))
            }
          />
        ) : null}
        {show("memory") ? (
          <Card className="gap-2 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm">Memory and swap</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p>
                RAM total:{" "}
                {snapshot?.memoryTotalBytes?.status === "ready"
                  ? formatBytes(snapshot.memoryTotalBytes.value)
                  : "—"}
              </p>
              <p>
                RAM used:{" "}
                {snapshot?.memoryUsedBytes?.status === "ready"
                  ? formatBytes(snapshot.memoryUsedBytes.value)
                  : "—"}
              </p>
              <p>
                RAM available:{" "}
                {snapshot?.memoryAvailableBytes?.status === "ready"
                  ? formatBytes(snapshot.memoryAvailableBytes.value)
                  : (snapshot?.memoryAvailableBytes?.status ?? "unavailable")}
              </p>
              <p>
                Swap total:{" "}
                {snapshot?.swapTotalBytes?.status === "ready"
                  ? formatBytes(snapshot.swapTotalBytes.value)
                  : "—"}
              </p>
              <p>
                Swap used:{" "}
                {snapshot?.swapUsedBytes?.status === "ready"
                  ? formatBytes(snapshot.swapUsedBytes.value)
                  : "—"}
              </p>
              <p>
                Swap free:{" "}
                {snapshot?.swapFreeBytes?.status === "ready"
                  ? formatBytes(snapshot.swapFreeBytes.value)
                  : (snapshot?.swapFreeBytes?.status ?? "unavailable")}
              </p>
            </CardContent>
          </Card>
        ) : null}
      </div>
      {show("temperatures") ? (
        <Card className="gap-2 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Temperatures</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 px-4 text-sm">
            {snapshot?.temperaturesCelsius.length ? (
              snapshot.temperaturesCelsius.map(({ name, metric }) => {
                const critical = criticalTemperature(snapshot, name);
                return (
                  <div key={name} className="flex flex-wrap justify-between gap-2">
                    <span className="truncate text-muted-foreground">{name}</span>
                    <span className="tabular-nums">
                      {metric.status === "ready" ? formatTemperature(metric.value) : metric.status}
                    </span>
                    {critical ? (
                      <span className="w-full text-xs text-muted-foreground">
                        Critical: {critical}
                      </span>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <p className="text-xs text-muted-foreground">
                No supported temperature sensor reported
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}
      {show("processes") ? (
        <ProcessTable
          rows={rows}
          controls={processes.controls}
          onControlsChange={processes.setControls}
          onNextPage={processes.next}
          onPreviousPage={processes.previous}
          hasNextPage={processes.hasNextPage}
          hasPreviousPage={processes.hasPreviousPage}
          status={
            connection === "unavailable" || collectionStatus?.state === "failed"
              ? "unavailable"
              : snapshot?.processStatus && snapshot.processStatus !== "ready"
                ? snapshot.processStatus
                : processes.status
          }
          truncated={processes.page?.truncatedInventory ?? false}
        />
      ) : null}
      {show("processes") && snapshot?.processStatus && snapshot.processStatus !== "ready" ? (
        <CenteredStatus
          loading={
            connection !== "unavailable" &&
            collectionStatus?.state !== "failed" &&
            isLoadingStatus(snapshot.processStatus)
          }
        >
          Process inventory: {snapshot.processStatus}
        </CenteredStatus>
      ) : null}
      {show("temperatures") && snapshot?.temperaturesCelsius.length ? (
        <p className="sr-only">
          {temperature.label}: {temperature.value}
        </p>
      ) : null}
    </div>
  );
}

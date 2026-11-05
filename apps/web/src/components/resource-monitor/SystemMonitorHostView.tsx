import { useMemo, useState } from "react";

import { retryResourceMonitor } from "~/stores/resource-monitor/resourceMonitor.store";
import { ResourceConnectionStatus } from "./ResourceConnectionStatus";
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
import { ResourceMemorySwap } from "./ResourceMemorySwap";
import { ResourceTemperatures } from "./ResourceTemperatures";
import { displayWidget } from "./resourceMonitor.display";
import { remoteProcessRows } from "./remoteProcessRows";
import { formatBytes, formatDecimal, formatPercent } from "./resourceMonitor.format";
import { useProcessPage } from "./useProcessPage";
import { useResourceMonitor } from "./useResourceMonitor";
import { useResourceDetailPreferences } from "~/stores/resource-monitor/resourceMonitorDetails.store";
import type { RemoteMonitorState } from "~/stores/resource-monitor/remoteMonitor.store";

export function SystemMonitorHostView({
  remote,
}: {
  remote?: { name: string; state?: RemoteMonitorState };
}) {
  const details = useResourceDetailPreferences((state) => state.visible);
  const show = (detail: (typeof details)[number]) => details.includes(detail);
  const local = useResourceMonitor(
    !remote,
    show("processes") && !remote,
    show("temperatures") && !remote,
  );
  const {
    snapshot,
    history,
    diskHistory,
    interfaceHistory,
    temperatureHistory,
    connection,
    reason,
    collectionStatus,
  } = remote
    ? {
        ...local,
        snapshot: remote.state?.snapshot ?? null,
        history: remote.state?.history ?? { cpu: [], memory: [], network: [] },
        connection: remote.state?.connection ?? "connecting",
        reason: remote.state?.reason ?? null,
        collectionStatus: null,
        diskHistory: {},
        interfaceHistory: {},
        temperatureHistory: {},
      }
    : local;
  const processes = useProcessPage(
    !remote &&
      show("processes") &&
      connection === "connected" &&
      (snapshot?.processStatus === "ready" || snapshot?.processStatus === "warming"),
  );
  const [remotePage, setRemotePage] = useState(0);
  const remoteRows = useMemo(
    () => remoteProcessRows(snapshot?.processRows ?? [], processes.controls),
    [snapshot?.processRows, processes.controls],
  );
  const pageIndex = Math.min(remotePage, Math.max(0, Math.ceil(remoteRows.length / 100) - 1));
  const rows = useMemo<DisplayProcess[]>(() => {
    const inventory = remote
      ? remoteRows.slice(pageIndex * 100, (pageIndex + 1) * 100)
      : (processes.page?.rows ?? []);
    return inventory.map((row) => ({
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
        ["Disk read", row.diskReadBytes === undefined ? "—" : formatBytes(row.diskReadBytes)],
        [
          "Disk written",
          row.diskWrittenBytes === undefined ? "—" : formatBytes(row.diskWrittenBytes),
        ],
      ],
    }));
  }, [processes.page, remote, remoteRows, pageIndex]);

  const cpu = displayWidget(snapshot, "cpu");
  const currentSummary =
    snapshot?.summaryStatus === "ready" ||
    (Boolean(remote) && snapshot?.summaryStatus === "partial");
  cpu.history = history.cpu;
  const memory = displayWidget(snapshot, "memory");
  memory.history = connection === "connected" && currentSummary ? history.memory : [];
  const disk = displayWidget(snapshot, "disk");
  const network = displayWidget(snapshot, "network");
  network.history = history.network;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">
            {remote ? `${remote.name} Monitor` : "System Monitor"}
          </h1>
          {show("ipAddress") ? (
            <p
              className="max-w-full truncate text-sm text-muted-foreground"
              title={snapshot?.hostname || undefined}
            >
              {snapshot?.hostname || (remote ? remote.name : "Desktop computer")} ·{" "}
              {remote ? "SSH host" : "desktop host"}
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
        <ResourceConnectionStatus
          connecting={connection === "connecting"}
          reason={reason}
          {...(remote ? { remoteName: remote.name } : {})}
        />
      ) : null}
      {connection === "connected" && !remote ? (
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
              currentSummary &&
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
          <ResourceNetworkInterfaces
            interfaces={snapshot?.interfaces ?? []}
            history={interfaceHistory}
            current={
              connection === "connected" &&
              currentSummary &&
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
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {show("cores") ? (
          <ResourceCpuCores
            cores={snapshot?.perCorePercent ?? []}
            active={
              connection === "connected" &&
              currentSummary &&
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
          <ResourceMemorySwap
            snapshot={snapshot}
            current={
              connection === "connected" &&
              currentSummary &&
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
      </div>
      {show("temperatures") ? (
        <ResourceTemperatures
          snapshot={snapshot}
          history={temperatureHistory}
          current={
            connection === "connected" &&
            currentSummary &&
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
      {show("processes") ? (
        <ProcessTable
          rows={rows}
          controls={processes.controls}
          onControlsChange={(next) => {
            if (remote) setRemotePage(0);
            processes.setControls(next);
          }}
          onNextPage={remote ? () => setRemotePage(pageIndex + 1) : processes.next}
          onPreviousPage={
            remote ? () => setRemotePage(Math.max(0, pageIndex - 1)) : processes.previous
          }
          hasNextPage={remote ? (pageIndex + 1) * 100 < remoteRows.length : processes.hasNextPage}
          hasPreviousPage={remote ? pageIndex > 0 : processes.hasPreviousPage}
          status={
            connection === "unavailable" || collectionStatus?.state === "failed"
              ? "unavailable"
              : snapshot?.processStatus && snapshot.processStatus !== "ready"
                ? snapshot.processStatus
                : remote
                  ? (snapshot?.processStatus ?? "warming")
                  : processes.status
          }
          truncated={
            remote
              ? (snapshot?.processRowsTruncated ?? false)
              : (processes.page?.truncatedInventory ?? false)
          }
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
    </div>
  );
}

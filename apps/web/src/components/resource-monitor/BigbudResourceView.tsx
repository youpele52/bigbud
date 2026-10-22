import { retryResourceMonitor } from "~/stores/resource-monitor/resourceMonitor.store";
import { ResourceConnectionStatus } from "./ResourceConnectionStatus";
import { ResourceCollectionStatus } from "./ResourceCollectionStatus";
import { BigbudResourceMetricCard } from "./BigbudResourceMetricCard";
import { BigbudResourceBreakdown } from "./BigbudResourceBreakdown";
import { appCard, appMetricValue, currentAppResources } from "./BigbudResourceView.logic";
import { formatCapacityGiB } from "./ResourceCapacityUsage.logic";
import { BigbudInclusiveResourceCard } from "./BigbudInclusiveResourceCard";
import { BigbudIoResourceCard } from "./BigbudIoResourceCard";
import { useResourceMonitor } from "./useResourceMonitor";
import { StatusBanner } from "../common/StatusBanner";
import { CenteredStatus } from "../common/CenteredStatus";

export function BigbudResourceView({
  visible,
  large = false,
}: {
  visible: boolean;
  large?: boolean;
}) {
  const { snapshot, appHistory, appReason, connection, reason, collectionStatus } =
    useResourceMonitor(visible, false, false, true);
  const app = currentAppResources(
    snapshot,
    connection === "connected" &&
      !appReason &&
      (!collectionStatus || collectionStatus.state === "healthy"),
  );
  const cpu = appCard(app?.core, "cpu");
  const memory = appCard(app?.core, "memory", snapshot?.memoryTotalBytes);
  if (connection === "unavailable" || appReason || collectionStatus?.state === "failed") {
    cpu.status = "unavailable";
    memory.status = "unavailable";
  }
  if (app && !app.incomplete) {
    cpu.history = appHistory.cpu;
    memory.history = appHistory.memory;
  }
  if (app?.incomplete) {
    cpu.capacity = undefined;
    memory.capacity = undefined;
  }
  const ioLabel = snapshot?.osName.toLowerCase().includes("windows") ? "Process I/O" : "Disk I/O";
  const pending =
    !appReason &&
    (connection === "connecting" ||
      (connection === "connected" && (!collectionStatus || collectionStatus.state !== "failed")));

  return (
    <section className="@container space-y-3 text-sm" aria-label="bigbud resource usage">
      <div>
        <h2 className="text-sm font-semibold">Core bigbud</h2>
        <p className="text-xs text-muted-foreground">
          Desktop + backend + registered native services
        </p>
      </div>
      {connection !== "connected" || appReason ? (
        <ResourceConnectionStatus
          scope="app"
          connecting={connection === "connecting" && !appReason}
          reason={appReason || reason}
        />
      ) : (
        <ResourceCollectionStatus
          status={collectionStatus}
          onRetry={() => void retryResourceMonitor()}
        />
      )}
      {connection === "connected" && !app && !appReason && collectionStatus?.state !== "failed" ? (
        <CenteredStatus loading={pending}>Waiting for a fresh bigbud sample</CenteredStatus>
      ) : null}
      {app?.incomplete ? (
        <StatusBanner
          dismissalKey={["resource-monitor", "app", "incomplete"]}
          variant="warning"
          dismissLabel="Dismiss incomplete resource measurement warning"
          description="Some owned processes could not be measured. Totals are unavailable rather than understated."
        />
      ) : null}
      <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
        <BigbudResourceMetricCard
          metric={cpu}
          kind="cpu"
          capacity={cpu.capacity}
          large={large}
          processCount={app?.core.processCount}
        />
        <BigbudResourceMetricCard
          metric={memory}
          kind="memory"
          memoryTotal={appMetricValue(snapshot?.memoryTotalBytes, formatCapacityGiB)}
          capacity={memory.capacity}
          large={large}
        />
      </div>
      <div className="grid auto-rows-fr grid-cols-1 items-stretch gap-2 @md:grid-cols-2">
        <BigbudIoResourceCard
          app={app}
          label={ioLabel}
          history={appHistory.io}
          large={large}
          pending={!app && pending}
        />
        <BigbudInclusiveResourceCard
          app={app}
          history={appHistory}
          large={large}
          pending={!app && pending}
        />
      </div>
      <BigbudResourceBreakdown groups={app?.groups ?? []} />
      <p className="text-xs text-muted-foreground">
        Local desktop host only. Detached processes without a current owned ancestor are excluded;
        memory can count shared pages more than once.
      </p>
    </section>
  );
}

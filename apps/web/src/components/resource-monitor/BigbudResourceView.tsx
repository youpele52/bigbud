import { retryResourceMonitor } from "~/stores/resource-monitor/resourceMonitor.store";
import { Button } from "../ui/button";
import { ResourceCollectionStatus } from "./ResourceCollectionStatus";
import { BigbudResourceMetricCard } from "./BigbudResourceMetricCard";
import { BigbudResourceBreakdown } from "./BigbudResourceBreakdown";
import { appCard, currentAppResources } from "./BigbudResourceView.logic";
import { BigbudInclusiveResourceCard } from "./BigbudInclusiveResourceCard";
import { BigbudIoResourceCard } from "./BigbudIoResourceCard";
import { useResourceMonitor } from "./useResourceMonitor";

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
  if (connection === "unavailable" || appReason) {
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

  return (
    <section className="@container space-y-3 text-sm" aria-label="bigbud resource usage">
      <div>
        <h2 className="text-sm font-semibold">Core bigbud</h2>
        <p className="text-xs text-muted-foreground">
          Desktop + backend + registered native services
        </p>
      </div>
      {connection !== "connected" || appReason ? (
        <div
          role="status"
          className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground"
        >
          <p>
            {connection === "connecting" && !appReason
              ? "Connecting to bigbud’s resource monitor…"
              : `bigbud monitoring unavailable${appReason || reason ? `: ${appReason || reason}` : ""}`}
          </p>
          {connection === "unavailable" || appReason ? (
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
      ) : (
        <ResourceCollectionStatus
          status={collectionStatus}
          onRetry={() => void retryResourceMonitor()}
        />
      )}
      {connection === "connected" && !app && !appReason ? (
        <p role="status" className="text-xs text-muted-foreground">
          Waiting for a fresh bigbud sample…
        </p>
      ) : null}
      {app?.incomplete ? (
        <p role="status" className="text-xs text-amber-600">
          Some owned processes could not be measured. Totals are unavailable rather than
          understated.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
        <BigbudResourceMetricCard metric={cpu} kind="cpu" capacity={cpu.capacity} large={large} />
        <BigbudResourceMetricCard
          metric={memory}
          kind="memory"
          capacity={memory.capacity}
          large={large}
        />
      </div>
      <div className="grid auto-rows-fr grid-cols-1 items-stretch gap-2 @md:grid-cols-2">
        <BigbudIoResourceCard app={app} label={ioLabel} history={appHistory.io} large={large} />
        <BigbudInclusiveResourceCard app={app} history={appHistory} large={large} />
      </div>
      <BigbudResourceBreakdown groups={app?.groups ?? []} />
      <p className="text-xs text-muted-foreground">
        Local desktop host only. Detached processes without a current owned ancestor are excluded;
        memory can count shared pages more than once.
      </p>
    </section>
  );
}

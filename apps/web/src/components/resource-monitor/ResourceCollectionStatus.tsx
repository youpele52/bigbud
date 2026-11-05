import type { MonitorCollectionStatus } from "@bigbud/contracts/system-monitor/types";

import { Button } from "../ui/button";
import { StatusBanner } from "../common/StatusBanner";

export function ResourceCollectionStatus({
  status,
  onRetry,
}: {
  status: MonitorCollectionStatus | null;
  onRetry: () => void;
}) {
  if (!status || status.state === "healthy") return null;

  const retrying = status.state === "retrying";
  return (
    <StatusBanner
      dismissalKey={["resource-monitor", "collection"]}
      dismissLabel="Dismiss resource collection status"
      variant={retrying ? "loading" : "error"}
      role={retrying ? "status" : "alert"}
      title={retrying ? "Resource collection is retrying" : "Resource collection failed"}
      description={
        <>
          {status.reason ? <p>{status.reason}</p> : null}
          {retrying ? (
            <p>
              Attempt {status.attempts} · retry delay {Math.ceil(status.retryAfterMs / 1000)} s
            </p>
          ) : (
            <Button size="xs" variant="outline" className="self-start" onClick={onRetry}>
              Retry collection
            </Button>
          )}
        </>
      }
    />
  );
}

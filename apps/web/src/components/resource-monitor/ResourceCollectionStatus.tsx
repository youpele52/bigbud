import type { MonitorCollectionStatus } from "@bigbud/contracts/system-monitor/types";

import { Button } from "../ui/button";

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
    <div
      role={retrying ? "status" : "alert"}
      className={`rounded-md border p-3 text-sm ${retrying ? "border-blue-500/30 bg-blue-500/5" : "border-red-500/30 bg-red-500/5"}`}
    >
      <p className="font-medium">
        {retrying ? "Resource collection is retrying" : "Resource collection failed"}
      </p>
      {status.reason ? <p className="mt-1 text-xs text-muted-foreground">{status.reason}</p> : null}
      {retrying ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Attempt {status.attempts} · retry delay {Math.ceil(status.retryAfterMs / 1000)} s
        </p>
      ) : (
        <Button size="xs" variant="outline" className="mt-2" onClick={onRetry}>
          Retry collection
        </Button>
      )}
    </div>
  );
}

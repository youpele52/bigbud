import { retryResourceMonitor } from "~/stores/resource-monitor/resourceMonitor.store";

import { StatusBanner } from "../common/StatusBanner";
import { CenteredStatus } from "../common/CenteredStatus";
import { Button } from "../ui/button";

/** Same host notice in the full monitor and compact system panel shares one dismissal. */
export function ResourceConnectionStatus({
  scope = "host",
  connecting,
  reason,
}: {
  scope?: "host" | "app";
  connecting: boolean;
  reason: string | null | undefined;
}) {
  const subject = scope === "app" ? "bigbud’s resource monitor" : "this computer’s System Monitor";
  const unavailable =
    scope === "app" ? "bigbud monitoring unavailable" : "System Monitor unavailable";
  return (
    <StatusBanner
      dismissalKey={["resource-monitor", scope, "connection"]}
      dismissLabel="Dismiss resource monitor connection status"
      role="presentation"
      centered
      variant={connecting ? "info" : "warning"}
      description={
        <CenteredStatus loading={connecting}>
          <p>
            {connecting
              ? `Connecting to ${subject}`
              : `${unavailable}${reason ? `: ${reason}` : ""}`}
          </p>
          {!connecting ? (
            <Button
              size="xs"
              variant="outline"
              className="mt-2"
              onClick={() => void retryResourceMonitor()}
            >
              Retry
            </Button>
          ) : null}
        </CenteredStatus>
      }
    />
  );
}

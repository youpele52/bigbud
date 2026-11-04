import { retryResourceMonitor } from "~/stores/resource-monitor/resourceMonitor.store";

import { StatusBanner } from "../common/StatusBanner";
import { Button } from "../ui/button";

/** Same host notice in the full monitor and compact system panel shares one dismissal. */
export function ResourceConnectionStatus({
  scope = "host",
  connecting,
  reason,
  remoteName,
}: {
  scope?: "host" | "app";
  connecting: boolean;
  reason: string | null | undefined;
  remoteName?: string;
}) {
  const subject =
    remoteName ??
    (scope === "app" ? "bigbud’s resource monitor" : "this computer’s System Monitor");
  const unavailable = remoteName
    ? `${remoteName} monitoring unavailable`
    : scope === "app"
      ? "bigbud monitoring unavailable"
      : "System Monitor unavailable";
  return (
    <StatusBanner
      dismissalKey={["resource-monitor", remoteName ?? scope, "connection"]}
      dismissLabel="Dismiss resource monitor connection status"
      role="status"
      variant={connecting ? "loading" : "warning"}
      description={
        <>
          <p>
            {connecting
              ? `Connecting to ${subject}`
              : `${unavailable}${reason ? `: ${reason}` : ""}`}
          </p>
          {!connecting && !remoteName ? (
            <Button
              size="xs"
              variant="outline"
              className="mt-2 self-start"
              onClick={() => void retryResourceMonitor()}
            >
              Retry
            </Button>
          ) : null}
        </>
      }
    />
  );
}

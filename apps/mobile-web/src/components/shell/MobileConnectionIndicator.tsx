import type { MobileRecoveryState } from "../../logic/mobileRecovery.types";
import type { MobileConnectionState } from "../../logic/mobileConnection.logic";
import { cn } from "../../lib/cn";
import { resolveMobileConnectionPresentation } from "./MobileConnectionNotice.logic";

export function MobileConnectionIndicator({
  state,
  connection,
}: {
  readonly state: MobileRecoveryState;
  readonly connection?: MobileConnectionState | undefined;
}) {
  const presentation = connection
    ? resolveMobileConnectionPresentation({ connection, recoveryState: state })
    : null;
  const quietReconnect = connection?.incidentLevel === "short";
  const label = presentation?.title ?? (quietReconnect ? "Reconnecting" : "Connection current");
  const tone =
    presentation?.tone === "destructive"
      ? "bg-destructive"
      : presentation?.tone === "warning"
        ? "bg-warning"
        : presentation?.tone === "info"
          ? "bg-info"
          : quietReconnect
            ? "bg-info"
            : state.freshness === "current"
              ? "bg-success"
              : state.freshness === "refreshing"
                ? "bg-info"
                : state.freshness === "stale" || state.freshness === "legacy"
                  ? "bg-warning"
                  : "bg-destructive";

  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone)} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

import { Button } from "../ui/button";
import type { MobileConnectionState } from "../../logic/mobileConnection.logic";
import type { MobileRecoveryState } from "../../logic/mobileRecovery.types";
import { cn } from "../../lib/cn";
import { resolveMobileConnectionNotice } from "./MobileConnectionNotice.logic";

export function MobileConnectionNotice({
  state,
  connection,
  onRetry,
}: {
  readonly state: MobileRecoveryState;
  readonly connection?: MobileConnectionState | undefined;
  readonly onRetry?: (() => void) | undefined;
}) {
  const notice = resolveMobileConnectionNotice(state, connection);
  if (!notice) return null;
  const tone =
    notice.tone === "info"
      ? "border-info/30 bg-info/8"
      : notice.tone === "warning"
        ? "border-warning/30 bg-warning/8"
        : "border-destructive/30 bg-destructive/8";
  const evidenceTimestamp = state.lastRefreshedAt ?? state.lastSynchronizedAt;
  const evidence =
    evidenceTimestamp === null
      ? "No successful refresh yet."
      : `Last refreshed at ${new Date(evidenceTimestamp).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })}.`;

  return (
    <div
      className={cn("flex items-start justify-between gap-3 rounded-lg border px-3 py-2", tone)}
      aria-atomic="true"
      aria-live="polite"
      role="status"
    >
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{notice.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{notice.description}</p>
        {state.freshness === "stale" || state.freshness === "legacy" ? (
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">{evidence}</p>
        ) : null}
      </div>
      {onRetry && notice.showRetry ? (
        <Button className="shrink-0" onClick={onRetry} size="sm" variant="outline">
          Retry
        </Button>
      ) : null}
    </div>
  );
}

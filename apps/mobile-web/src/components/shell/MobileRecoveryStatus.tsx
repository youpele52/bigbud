import { describeRecoveryReason, type MobileRecoveryState } from "../../logic/mobileRecovery.types";
import { Button } from "../ui/button";

export function MobileRecoveryStatus({
  state,
  onRetry,
}: {
  readonly state: MobileRecoveryState;
  readonly onRetry: () => void;
}) {
  const message =
    state.freshness === "stale"
      ? "Showing last-known data."
      : state.freshness === "legacy"
        ? "Live recovery markers are unavailable; data may be behind."
        : null;
  if (message === null) return null;
  const timestamp = state.lastRefreshedAt ?? state.lastSynchronizedAt;
  const evidence =
    timestamp === null
      ? "No successful refresh yet."
      : `${state.lastRefreshedAt !== null ? "Last refreshed" : "Last verified current data"} at ${new Date(
          timestamp,
        ).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })}.`;

  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-muted-foreground"
      role="status"
    >
      <div>
        <p>{message}</p>
        <p className="text-[11px] text-muted-foreground/70">
          {evidence}
          {state.reason && state.reason !== "recovery-unsupported" ? (
            <span className="sr-only"> {describeRecoveryReason(state.reason)}</span>
          ) : null}
        </p>
      </div>
      <Button className="shrink-0" onClick={onRetry} size="sm" variant="outline">
        Retry
      </Button>
    </div>
  );
}

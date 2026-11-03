import { Button } from "../ui/button";
import type { MobileConnectionState } from "../../logic/mobileConnection.logic";
import type { MobileRecoveryState } from "../../logic/mobileRecovery.types";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
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
    notice.tone === "info" ? "loading" : notice.tone === "destructive" ? "error" : "warning";
  const evidenceTimestamp = state.lastRefreshedAt ?? state.lastSynchronizedAt;
  const evidence =
    evidenceTimestamp === null
      ? "No successful refresh yet."
      : `Last refreshed at ${new Date(evidenceTimestamp).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })}.`;

  return (
    <Alert variant={tone} className="px-3 py-2" aria-atomic="true" aria-live="polite" role="status">
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>
        <p>{notice.description}</p>
        {state.freshness === "stale" || state.freshness === "legacy" ? (
          <p className="mt-0.5 text-sm text-muted-foreground/70">{evidence}</p>
        ) : null}
      </AlertDescription>
      {onRetry && notice.showRetry ? (
        <AlertAction>
          <Button className="shrink-0" onClick={onRetry} size="sm" variant="outline">
            Retry
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}

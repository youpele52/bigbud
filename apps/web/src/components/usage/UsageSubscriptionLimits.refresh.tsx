import { PROVIDER_DISPLAY_NAMES } from "@bigbud/contracts/constants/provider.constant.ts";
import { ServerRefreshUsageLimitsResult } from "@bigbud/contracts/server/rpc.usage.ts";
import type { SubscriptionRefreshOutcome } from "@bigbud/contracts/server/usageLimits.ts";
import { Schema } from "effect";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { useWsConnectionStatus } from "../../rpc/wsConnectionState";
import { RefreshIconButton } from "../ui/RefreshIconButton";
import { createSubscriptionRefreshCoordinator } from "./UsageSubscriptionLimits.polling";

const isRefreshResult = Schema.is(ServerRefreshUsageLimitsResult);
const subscriptionRefresh = createSubscriptionRefreshCoordinator(async () => {
  const result = await ensureNativeApi().server.refreshUsageLimits();
  if (!isRefreshResult(result)) throw new Error("No subscription refresh outcomes returned.");
  return result;
});

const outcomeLabels: Record<SubscriptionRefreshOutcome["status"], string> = {
  fresh: "Updated",
  cached: "Cached values",
  unavailable: "Allowance unavailable",
  failed: "Refresh failed",
  skipped: "Not refreshed",
  "timed-out": "Refresh timed out",
};

export function UsageSubscriptionLimitsRefresh({
  children,
  visible,
}: {
  readonly children: ReactNode;
  readonly visible: boolean;
}) {
  const { phase, connectedAt } = useWsConnectionStatus();

  useEffect(() => {
    if (!visible || phase !== "connected") return;
    let unwatch: (() => void) | undefined;
    function syncVisibility() {
      if (document.visibilityState === "visible") {
        unwatch ??= subscriptionRefresh.watch();
      } else {
        unwatch?.();
        unwatch = undefined;
      }
    }
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      unwatch?.();
    };
  }, [visible, phase, connectedAt]);
  const refreshing = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [outcomes, setOutcomes] = useState<ReadonlyArray<SubscriptionRefreshOutcome>>();

  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    setIsRefreshing(true);
    setFailed(false);
    setOutcomes(undefined);
    try {
      setOutcomes((await subscriptionRefresh.refresh()).outcomes);
    } catch (error) {
      console.warn("Failed to refresh subscription limits", error);
      setFailed(true);
    } finally {
      refreshing.current = false;
      setIsRefreshing(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        {children}
        <RefreshIconButton
          label="Refresh subscription limits"
          busy={isRefreshing}
          onClick={() => void refresh()}
        />
      </div>
      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          Couldn’t refresh limits. Try again.
        </p>
      ) : null}
      <div role="status" className="text-xs text-muted-foreground empty:hidden">
        {outcomes?.length ? (
          <ul aria-label="Subscription refresh results" className="flex flex-wrap gap-x-3 gap-y-1">
            {outcomes.map(({ provider, status }) => (
              <li key={provider} className={status === "fresh" ? undefined : "text-warning"}>
                {PROVIDER_DISPLAY_NAMES[provider]}: {outcomeLabels[status]}
              </li>
            ))}
          </ul>
        ) : outcomes ? (
          "No enabled subscription readers."
        ) : null}
      </div>
    </>
  );
}

import { useRef, useState } from "react";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { RefreshIconButton } from "../ui/RefreshIconButton";

export function UsageSubscriptionLimitsRefresh() {
  const refreshing = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);

  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    setIsRefreshing(true);
    setFailed(false);
    try {
      await ensureNativeApi().server.refreshUsageLimits();
    } catch (error) {
      console.warn("Failed to refresh subscription limits", error);
      setFailed(true);
    } finally {
      refreshing.current = false;
      setIsRefreshing(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      {failed ? (
        <span role="alert" className="text-xs text-destructive">
          Couldn’t refresh limits. Try again.
        </span>
      ) : null}
      <RefreshIconButton
        label="Refresh subscription limits"
        busy={isRefreshing}
        onClick={() => void refresh()}
      />
    </div>
  );
}

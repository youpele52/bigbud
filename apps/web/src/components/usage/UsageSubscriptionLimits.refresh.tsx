import { useRef, useState } from "react";
import { LoaderIcon, RefreshCwIcon } from "lucide-react";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
              disabled={isRefreshing}
              onClick={() => void refresh()}
              aria-label="Refresh subscription limits"
              aria-busy={isRefreshing}
            >
              {isRefreshing ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3" />
              )}
            </Button>
          }
        />
        <TooltipPopup side="top">Refresh subscription limits</TooltipPopup>
      </Tooltip>
    </div>
  );
}

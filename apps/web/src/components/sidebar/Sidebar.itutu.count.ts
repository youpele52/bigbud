import { useEffect, useState } from "react";
import type { OrchestrationDeliveryStreamItem } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";
import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";

import { ITUTU_COUNT_REFRESH_DELAY_MS } from "../../constants/sidebar";
import { readNativeApi } from "../../rpc/nativeApi";

export type ItutuCountResult =
  | { status: "loading" }
  | { status: "loaded"; count: number }
  | { status: "error" };

export function shouldRefreshItutuThreadCounts(item: OrchestrationDeliveryStreamItem): boolean {
  if (item.type === "recovery") return true;
  if (item.type === "lifecycle") return item.state === "live" || item.state === "fallback";
  return item.events.some((event) => {
    switch (event.type) {
      case "thread.created":
      case "thread.organization-updated":
      case "thread.deletion-requested":
      case "thread.deletion-failed":
      case "thread.deleted":
      case "thread.archived":
      case "thread.unarchived":
      case "project.deleted":
        return true;
      default:
        return false;
    }
  });
}

/** Exact totals, including collapsed/unloaded threads; refreshes never hold up event delivery. */
export function useItutuThreadCount(state: ThreadOrganizationState): ItutuCountResult {
  const [result, setResult] = useState<ItutuCountResult>({ status: "loading" });

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let requested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const api = readNativeApi();
    setResult({ status: "loading" });

    const refresh = async () => {
      requested = true;
      if (inFlight) return;
      inFlight = true;
      while (requested) {
        if (disposed) break;
        requested = false;
        try {
          const page = await api?.orchestration.getOrganizationThreadSummaries({
            state,
            limit: 1,
            includeTotalCount: true,
          });
          if (!disposed && !requested) {
            setResult(
              page?.totalCount === undefined
                ? { status: "error" }
                : { status: "loaded", count: page.totalCount },
            );
          }
        } catch {
          if (!disposed && !requested) setResult({ status: "error" });
        }
      }
      inFlight = false;
    };
    const scheduleRefresh = () => {
      if (disposed || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, ITUTU_COUNT_REFRESH_DELAY_MS);
    };
    const unsubscribe = api?.orchestration.onDomainEvent(
      (item) => {
        if (shouldRefreshItutuThreadCounts(item)) scheduleRefresh();
      },
      { onResubscribe: scheduleRefresh },
    );
    void refresh();

    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [state]);

  return result;
}

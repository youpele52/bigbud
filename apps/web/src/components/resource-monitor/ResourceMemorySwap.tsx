import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { isLoadingStatus } from "../common/CenteredStatus.logic";
import { ResourceCapacityUsage } from "./ResourceCapacityUsage";
import { memorySwapUsage } from "./ResourceMemorySwap.logic";

/** Keep RAM and Swap together while sharing the Disk card's capacity-bar presentation. */
export function ResourceMemorySwap({
  snapshot,
  current,
  loading,
}: {
  snapshot: MonitorSnapshot | null;
  current: boolean;
  loading: boolean;
}) {
  const { ram, swap, noSwap } = memorySwapUsage(snapshot, current);
  return (
    <Card role="region" aria-label="Memory and swap" className="min-w-0 gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Memory and swap</CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4 px-4">
        <section aria-label="RAM" className="min-w-0 space-y-3">
          <h3 className="text-sm font-medium">RAM</h3>
          <ResourceCapacityUsage
            usage={ram}
            label="RAM"
            allowOverCapacity
            loading={
              loading ||
              (current &&
                [snapshot?.memoryUsedBytes, snapshot?.memoryTotalBytes].some(
                  (metric) => metric !== undefined && isLoadingStatus(metric.status),
                ))
            }
          />
        </section>
        <section aria-label="Swap" className="min-w-0 space-y-3 border-t border-border/60 pt-4">
          <h3 className="text-sm font-medium">Swap</h3>
          <ResourceCapacityUsage
            usage={swap}
            label="Swap"
            {...(noSwap ? { unavailableLabel: "No swap allocated" } : {})}
            loading={
              !noSwap &&
              (loading ||
                (current &&
                  [snapshot?.swapUsedBytes, snapshot?.swapTotalBytes].some(
                    (metric) => metric !== undefined && isLoadingStatus(metric.status),
                  )))
            }
          />
        </section>
      </CardContent>
    </Card>
  );
}

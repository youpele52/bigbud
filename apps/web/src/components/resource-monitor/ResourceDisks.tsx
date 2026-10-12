import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import {
  diskHistoryKey,
  type DiskHistory,
} from "~/stores/resource-monitor/resourceMonitor.diskHistory";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { CenteredStatus } from "../common/CenteredStatus";
import { ResourceDisk } from "./ResourceDisk";

/** All disk volumes use the full monitor width rather than a half-width details card. */
export function ResourceDisks({
  snapshot,
  history,
  active,
  loading,
}: {
  snapshot: MonitorSnapshot | null;
  history: DiskHistory;
  active: boolean;
  loading: boolean;
}) {
  return (
    <Card className="col-span-full min-w-0 gap-2 py-4" role="region" aria-label="Disks">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Disks</CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 space-y-3 px-4">
        {snapshot?.disks.length ? (
          snapshot.disks.map((disk) => (
            <ResourceDisk
              key={diskHistoryKey(disk)}
              disk={disk}
              history={history[diskHistoryKey(disk)] ?? []}
              active={active}
            />
          ))
        ) : (
          <CenteredStatus loading={loading} className="min-h-24">
            {loading ? "Waiting for disk details" : "No disk details available"}
          </CenteredStatus>
        )}
      </CardContent>
    </Card>
  );
}

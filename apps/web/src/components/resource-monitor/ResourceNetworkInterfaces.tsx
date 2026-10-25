import type { MonitorNetworkInterface } from "@bigbud/contracts/system-monitor/types";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { CenteredStatus } from "../common/CenteredStatus";
import {
  interfaceHistoryKey,
  type InterfaceHistory,
} from "~/stores/resource-monitor/resourceMonitor.interfaceHistory";
import { ResourceNetworkInterface } from "./ResourceNetworkInterface";

export function ResourceNetworkInterfaces({
  interfaces,
  history = {},
  current = true,
  loading = false,
}: {
  interfaces: readonly MonitorNetworkInterface[];
  history?: InterfaceHistory;
  current?: boolean;
  loading?: boolean;
}) {
  const [showHistory, setShowHistory] = useState(true);
  const ordered = interfaces.toSorted((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true }),
  );
  return (
    <Card
      role="region"
      aria-label="Network interfaces"
      className="@container col-span-full min-w-0 gap-2 py-4"
    >
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 px-4">
        <CardTitle className="text-sm">Network interfaces</CardTitle>
        <Button
          size="xs"
          variant={showHistory ? "outline" : "ghost"}
          aria-label="Show interface history"
          aria-pressed={showHistory}
          onClick={() => setShowHistory((previous) => !previous)}
        >
          History
        </Button>
      </CardHeader>
      <CardContent className="min-w-0 space-y-3 px-4">
        {ordered.length ? (
          <div className="grid grid-cols-1 items-start gap-3 @min-[640px]:grid-cols-2">
            {ordered.map((item) => (
              <ResourceNetworkInterface
                key={item.name}
                item={item}
                history={history[interfaceHistoryKey(item)] ?? []}
                showHistory={showHistory}
                current={current}
              />
            ))}
          </div>
        ) : (
          <CenteredStatus loading={loading} className="min-h-24">
            {loading ? "Waiting for interface details" : "No interface details available"}
          </CenteredStatus>
        )}
        {ordered.length ? (
          <p className="text-xs text-muted-foreground">
            Reported totals are per interface. Bridges and tunnels can count the same traffic more
            than once.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

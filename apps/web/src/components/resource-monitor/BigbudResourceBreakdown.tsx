import type { MonitorAppGroup } from "@bigbud/contracts/system-monitor/types";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { APP_GROUP_LABELS, appMetricValue } from "./BigbudResourceView.logic";
import { formatBytes, formatPercent } from "./resourceMonitor.format";

export function BigbudResourceBreakdown({ groups }: { groups: readonly MonitorAppGroup[] }) {
  return (
    <Card className="gap-2 py-3">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Component breakdown</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto px-4">
        <table className="w-full text-sm">
          <caption className="sr-only">Observed bigbud process groups</caption>
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="pb-2 text-left font-normal">
                Component
              </th>
              <th scope="col" className="pb-2 text-right font-normal">
                Processes
              </th>
              <th scope="col" className="pb-2 text-right font-normal">
                CPU
              </th>
              <th scope="col" className="pb-2 text-right font-normal">
                Memory
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={group.role} className="border-t">
                <th scope="row" className="py-2 pr-3 text-left font-medium">
                  {APP_GROUP_LABELS[group.role]}
                </th>
                <td className="py-2 text-right tabular-nums">{group.processCount}</td>
                <td className="py-2 pl-3 text-right tabular-nums">
                  {appMetricValue(group.cpuPercent, formatPercent)}
                </td>
                <td className="py-2 pl-3 text-right whitespace-nowrap tabular-nums">
                  {appMetricValue(group.residentBytes, formatBytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

import type { MonitorNetworkInterface } from "@bigbud/contracts/system-monitor/types";
import type { HistoryPoint } from "~/stores/resource-monitor/resourceMonitor.store";
import { ResourceDetailDialog } from "./ResourceDetailDialog";
import { ResourceNetworkInterfaceContent } from "./ResourceNetworkInterfaceContent";

/** Share live readings between the compact card and its expanded view. */
export function ResourceNetworkInterface({
  item,
  history,
  showHistory,
  current,
}: {
  item: MonitorNetworkInterface;
  history: HistoryPoint[];
  showHistory: boolean;
  current: boolean;
}) {
  return (
    <ResourceDetailDialog
      title={`${item.name} network interface`}
      description={`Live network history and technical details for ${item.name}.`}
      expandedContent={
        <ResourceNetworkInterfaceContent
          item={item}
          history={history}
          showHistory
          current={current}
          expanded
        />
      }
    >
      {(trigger) => (
        <ResourceNetworkInterfaceContent
          item={item}
          history={history}
          showHistory={showHistory}
          current={current}
          headerAction={trigger}
        />
      )}
    </ResourceDetailDialog>
  );
}

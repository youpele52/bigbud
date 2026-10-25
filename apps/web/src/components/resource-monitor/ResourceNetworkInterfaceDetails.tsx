import type { MonitorNetworkInterface } from "@bigbud/contracts/system-monitor/types";
import { ChevronDownIcon } from "lucide-react";
import { interfaceMetricText } from "./ResourceNetworkInterface.logic";

/** Keep low-priority technical counters behind a native keyboard-accessible disclosure. */
export function ResourceNetworkInterfaceDetails({
  item,
  expanded = false,
}: {
  item: MonitorNetworkInterface;
  expanded?: boolean;
}) {
  const fields = [
    {
      label: "MTU",
      metric: item.mtuBytes,
      format: (value: number) => `${value.toLocaleString()} B`,
    },
    {
      label: "Packets received",
      metric: item.receivedPackets,
      format: (value: number) => value.toLocaleString(),
    },
    {
      label: "Packets transmitted",
      metric: item.transmittedPackets,
      format: (value: number) => value.toLocaleString(),
    },
    {
      label: "Receive errors",
      metric: item.receiveErrors,
      format: (value: number) => value.toLocaleString(),
    },
    {
      label: "Transmit errors",
      metric: item.transmitErrors,
      format: (value: number) => value.toLocaleString(),
    },
  ];
  const content = (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 pt-3 @min-[640px]:grid-cols-3">
      {fields.map(({ label, metric, format }) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="break-words text-xs tabular-nums" title={metric?.status ?? "unavailable"}>
            {interfaceMetricText(metric, format)}
          </dd>
        </div>
      ))}
    </dl>
  );
  if (expanded) return <div className="border-t border-border/60">{content}</div>;
  return (
    <details className="group border-t border-border/60 pt-3">
      <summary
        aria-label={`Details for ${item.name}`}
        className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
      >
        Details{" "}
        <ChevronDownIcon
          aria-hidden="true"
          className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      {content}
    </details>
  );
}

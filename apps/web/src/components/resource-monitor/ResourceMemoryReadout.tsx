import { ResourceMetricBadge } from "./ResourceMetricBadge";

/** The header retains estimate context while displaying the same used/total pair in both scopes. */
export function ResourceMemoryReadout({
  used,
  total,
  estimated = false,
}: {
  used: string;
  total: string;
  estimated?: boolean;
}) {
  return (
    <ResourceMetricBadge
      aria-label={`${used} used of ${total} total${estimated ? " · estimated" : ""}`}
      title={estimated ? "bigbud usage / total memory · estimated" : "Used / total memory"}
    >
      {used} / {total}
    </ResourceMetricBadge>
  );
}

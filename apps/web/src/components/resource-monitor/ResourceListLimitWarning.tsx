import { TriangleAlertIcon } from "lucide-react";

import { StatusBanner } from "../common/StatusBanner";

export function ResourceListLimitWarning() {
  return (
    <StatusBanner
      dismissalKey={["resource-monitor", "list-limit"]}
      variant="warning"
      icon={<TriangleAlertIcon />}
      title="Some resource lists were capped by the monitor"
      description="Values shown below are partial."
      dismissLabel="Dismiss resource list warning"
    />
  );
}

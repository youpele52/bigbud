import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { StatusBanner } from "../common/StatusBanner";

let resourceListLimitWarningDismissed = false;

export function ResourceListLimitWarning() {
  const [dismissed, setDismissed] = useState(() => resourceListLimitWarningDismissed);
  if (dismissed) return null;

  return (
    <StatusBanner
      variant="warning"
      icon={<TriangleAlertIcon />}
      title="Some resource lists were capped by the monitor"
      description="Values shown below are partial."
      dismissLabel="Dismiss resource list warning"
      onDismiss={() => {
        resourceListLimitWarningDismissed = true;
        setDismissed(true);
      }}
    />
  );
}

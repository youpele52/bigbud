import { PROVIDER_DISPLAY_NAMES, type ServerUsageSummaryResult } from "@bigbud/contracts";
import { InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { StatusBanner } from "../common/StatusBanner";

let unavailableUsageWarningDismissed = false;

export function UsageDataStatus({ summary }: { readonly summary: ServerUsageSummaryResult }) {
  const [isUnavailableWarningDismissed, setIsUnavailableWarningDismissed] = useState(
    () => unavailableUsageWarningDismissed,
  );
  const unavailableProviders = summary.providerCoverage.filter(
    (coverage) => coverage.status === "unavailable",
  );

  if (summary.historyStatus === "ready" && unavailableProviders.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {summary.historyStatus === "building" ? (
        <StatusBanner
          variant="info"
          icon={<InfoIcon />}
          title="Indexing historical usage"
          description="Recent usage is available now. Older usage will appear as background indexing completes."
        />
      ) : null}
      {unavailableProviders.length > 0 && !isUnavailableWarningDismissed ? (
        <StatusBanner
          variant="warning"
          icon={<TriangleAlertIcon />}
          title="Usage unavailable for some providers"
          description={`${unavailableProviders.map((coverage) => PROVIDER_DISPLAY_NAMES[coverage.provider]).join(", ")} do not expose reliable token usage, so their totals are not estimated.`}
          dismissLabel="Dismiss usage availability warning"
          onDismiss={() => {
            unavailableUsageWarningDismissed = true;
            setIsUnavailableWarningDismissed(true);
          }}
        />
      ) : null}
    </div>
  );
}

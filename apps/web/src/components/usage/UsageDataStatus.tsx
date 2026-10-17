import { PROVIDER_DISPLAY_NAMES, type ServerUsageSummaryResult } from "@bigbud/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { StatusBanner } from "../common/StatusBanner";
import { CenteredStatus } from "../common/CenteredStatus";

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
        <CenteredStatus loading className="rounded-xl border border-info/32 bg-info/4 px-3.5 py-3">
          <p className="font-medium text-foreground">Indexing historical usage</p>
          <p className="mt-1">
            Recent usage is available now. Older usage will appear as background indexing completes.
          </p>
        </CenteredStatus>
      ) : null}
      {unavailableProviders.length > 0 && !isUnavailableWarningDismissed ? (
        <StatusBanner
          centered
          variant="warning"
          icon={<TriangleAlertIcon />}
          title="Usage unavailable for some providers"
          description={`${unavailableProviders.map((coverage) => PROVIDER_DISPLAY_NAMES[coverage.provider]).join(", ")} do not expose reliable official token usage. Disclosed observable-content estimates may be used.`}
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

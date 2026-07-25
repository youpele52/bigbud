import { InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { PROVIDER_DISPLAY_NAMES, type ServerUsageSummaryResult } from "@bigbud/contracts";
import { useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";

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
        <Alert variant="info">
          <InfoIcon />
          <AlertTitle>Indexing historical usage</AlertTitle>
          <AlertDescription>
            Recent usage is available now. Older usage will appear as background indexing completes.
          </AlertDescription>
        </Alert>
      ) : null}
      {unavailableProviders.length > 0 && !isUnavailableWarningDismissed ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Usage unavailable for some providers</AlertTitle>
          <AlertDescription>
            {unavailableProviders
              .map((coverage) => PROVIDER_DISPLAY_NAMES[coverage.provider])
              .join(", ")}{" "}
            do not expose reliable token usage, so their totals are not estimated.
          </AlertDescription>
          <AlertAction>
            <button
              type="button"
              aria-label="Dismiss usage availability warning"
              className="inline-flex size-6 items-center justify-center rounded-md text-warning/60 transition-colors hover:text-warning"
              onClick={() => {
                unavailableUsageWarningDismissed = true;
                setIsUnavailableWarningDismissed(true);
              }}
            >
              <XIcon className="size-3.5" />
            </button>
          </AlertAction>
        </Alert>
      ) : null}
    </div>
  );
}

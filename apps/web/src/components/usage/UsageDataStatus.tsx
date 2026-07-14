import { InfoIcon, TriangleAlertIcon } from "lucide-react";
import { PROVIDER_DISPLAY_NAMES, type ServerUsageSummaryResult } from "@bigbud/contracts";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

export function UsageDataStatus({ summary }: { readonly summary: ServerUsageSummaryResult }) {
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
      {unavailableProviders.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Usage unavailable for some providers</AlertTitle>
          <AlertDescription>
            {unavailableProviders
              .map((coverage) => PROVIDER_DISPLAY_NAMES[coverage.provider])
              .join(", ")}{" "}
            do not expose reliable token usage, so their totals are not estimated.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

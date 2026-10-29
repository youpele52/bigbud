import { PROVIDER_DISPLAY_NAMES, type ServerUsageSummaryResult } from "@bigbud/contracts";

import { StatusBanner } from "../common/StatusBanner";

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
        <StatusBanner
          dismissalKey={["usage", "history-indexing"]}
          dismissLabel="Dismiss historical usage indexing status"
          role="status"
          variant="loading"
          title="Indexing historical usage"
          description="Recent usage is available now. Older usage will appear as background indexing completes."
        />
      ) : null}
      {unavailableProviders.length > 0 ? (
        <StatusBanner
          dismissalKey={["usage", "unavailable-providers"]}
          variant="warning"
          title="Usage unavailable for some providers"
          description={`${unavailableProviders.map((coverage) => PROVIDER_DISPLAY_NAMES[coverage.provider as keyof typeof PROVIDER_DISPLAY_NAMES] ?? coverage.provider).join(", ")} do not expose reliable official token usage. Disclosed observable-content estimates may be used.`}
          dismissLabel="Dismiss usage availability warning"
        />
      ) : null}
    </div>
  );
}

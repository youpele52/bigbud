import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import { useServerConfig, useServerProviders } from "~/rpc/serverState";
import { cn } from "~/lib/utils";
import { UsageSectionLoader } from "./UsageSectionLoader";
import {
  STANDALONE_PAGE_SCROLL_CLASS,
  STANDALONE_PAGE_WIDTH_CLASS,
} from "../standalone/StandalonePageContent";
import { UsageDataStatus } from "./UsageDataStatus";
import { applyUsageDisplayLabels } from "./UsagePage.labels";
import { UsageOverviewCard } from "./UsageOverviewCard";
import { UsageSubscriptionLimits } from "./UsageSubscriptionLimits";
import { useUsagePanelSummary } from "./useUsagePanelSummary";
import { CenteredStatus } from "../common/CenteredStatus";
import { UsageAccountingFooter } from "./UsageAccountingFooter";

export function UsagePanel({ visible }: { visible: boolean }) {
  const providers = useServerProviders();
  const providersLoading = useServerConfig() === null;
  const { summary, loading, error } = useUsagePanelSummary(visible);
  const displaySummary = summary ? applyUsageDisplayLabels(summary, providers) : null;

  return (
    <div className={STANDALONE_PAGE_SCROLL_CLASS}>
      <div className={cn("@container space-y-4 p-4 text-sm", STANDALONE_PAGE_WIDTH_CLASS)}>
        <h2 className="text-sm font-semibold">Usage</h2>
        <section aria-label="Usage overview" className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">24-hour overview</h3>
          </div>
          {error ? (
            <CenteredStatus className="text-xs text-amber-600 dark:text-amber-400">
              {error}
              {error && summary ? " Showing last successful data; values may be out of date." : ""}
            </CenteredStatus>
          ) : null}
          {loading && displaySummary ? (
            <CenteredStatus loading className="text-xs text-muted-foreground">
              Refreshing usage
            </CenteredStatus>
          ) : null}
          {displaySummary ? (
            <>
              <UsageDataStatus summary={displaySummary} />
              <UsageOverviewCard summary={displaySummary} />
            </>
          ) : loading ? (
            <UsageSectionLoader overview label="Loading usage overview" />
          ) : null}
        </section>
        <UsageSubscriptionLimits
          compact
          loading={providersLoading}
          limits={providers
            .filter((provider) => provider.enabled)
            .map((provider) => provider.usageLimits)}
        />
        <Link
          to="/usage"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          View full usage <ArrowRightIcon className="size-3.5" />
        </Link>
        {displaySummary ? <UsageAccountingFooter summary={displaySummary} /> : null}
      </div>
    </div>
  );
}

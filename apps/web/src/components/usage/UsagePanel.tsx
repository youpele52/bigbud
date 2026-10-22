import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, CpuIcon, FlameIcon, SigmaIcon } from "lucide-react";
import { AiIcon } from "../AiIcon";

import { useServerProviders } from "~/rpc/serverState";
import { cn } from "~/lib/utils";
import {
  STANDALONE_PAGE_SCROLL_CLASS,
  STANDALONE_PAGE_WIDTH_CLASS,
} from "../standalone/StandalonePageContent";
import { UsageDataStatus } from "./UsageDataStatus";
import { applyUsageDisplayLabels } from "./UsagePage.labels";
import { UsageStatCard } from "./UsagePage.stat";
import { UsageSubscriptionLimits } from "./UsageSubscriptionLimits";
import { useUsagePanelSummary } from "./useUsagePanelSummary";
import { CenteredStatus } from "../common/CenteredStatus";
import { UsageAccountingFooter } from "./UsageAccountingFooter";
import { usageSourceLabel } from "./UsageAccounting.logic";

export function UsagePanel({ visible }: { visible: boolean }) {
  const providers = useServerProviders();
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
          {loading || error ? (
            <CenteredStatus
              loading={loading && !error}
              className={
                error
                  ? "text-xs text-amber-600 dark:text-amber-400"
                  : "text-xs text-muted-foreground"
              }
            >
              {error ?? (summary ? "Refreshing usage" : "Loading usage")}
              {error && summary ? " Showing last successful data; values may be out of date." : ""}
            </CenteredStatus>
          ) : null}
          {displaySummary ? (
            <>
              <UsageDataStatus summary={displaySummary} />
              <div className="grid grid-cols-2 gap-2 @min-[800px]:grid-cols-4">
                <UsageStatCard
                  compact
                  icon={SigmaIcon}
                  label="Total tokens"
                  sourceLabel={usageSourceLabel(displaySummary.totals.accounting)}
                  value={displaySummary.totals.usedTokens.toLocaleString()}
                />
                <UsageStatCard
                  compact
                  icon={CpuIcon}
                  label="Top provider"
                  value={displaySummary.favoriteProvider?.label ?? "None"}
                />
                <UsageStatCard
                  compact
                  icon={AiIcon}
                  label="Top model"
                  value={displaySummary.favoriteModel?.label ?? "None"}
                />
                <UsageStatCard
                  compact
                  icon={FlameIcon}
                  label="Current streak · UTC"
                  value={`${displaySummary.streakDays}d`}
                />
              </div>
            </>
          ) : null}
        </section>
        <UsageSubscriptionLimits
          compact
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

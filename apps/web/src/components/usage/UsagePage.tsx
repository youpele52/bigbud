import { UsageIcon } from "./UsageIcon";
import { useMemo, useState } from "react";

import { type ServerUsageRange } from "@bigbud/contracts";

import { usePageTitle } from "~/hooks/usePageTitle";
import { useServerConfig, useServerProviders } from "~/rpc/serverState";
import { Card, CardContent } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { StandaloneChatPageHeader } from "../standalone/StandaloneChatPageHeader";
import { StandaloneChatPageShell } from "../standalone/StandaloneChatPageShell";
import { StandalonePageContent } from "../standalone/StandalonePageContent";
import { UsageSectionLoader } from "./UsageSectionLoader";
import { UsageBreakdownCard, type UsageBreakdownView } from "./UsageBreakdownCard";
import { UsageDataStatus } from "./UsageDataStatus";
import { UsageDefinitions } from "./UsagePage.definitions";
import { fillUsageTimeline } from "./UsagePage.buckets.logic";
import { applyUsageDisplayLabels } from "./UsagePage.labels";
import { UsageOverviewCard } from "./UsageOverviewCard";
import { UsageSubscriptionLimits } from "./UsageSubscriptionLimits";
import { UsageTokenUsageCard } from "./UsageTokenUsageCard";
import { UsageAccountingFooter } from "./UsageAccountingFooter";
import { useUsagePageSummary } from "./UsagePage.loading";

const RANGE_OPTIONS: ReadonlyArray<ServerUsageRange> = ["24h", "7d", "30d", "all"];

export function UsagePage() {
  usePageTitle("Usage");

  const serverProviders = useServerProviders();
  const providersLoading = useServerConfig() === null;
  const [range, setRange] = useState<ServerUsageRange>("7d");
  const { summary, loading, error } = useUsagePageSummary(range);
  const [breakdownView, setBreakdownView] = useState<UsageBreakdownView>("trend");
  const subscriptionLimits = serverProviders
    .filter((provider) => provider.enabled)
    .map((provider) => provider.usageLimits);
  const displaySummary = useMemo(
    () => (summary ? applyUsageDisplayLabels(summary, serverProviders) : null),
    [serverProviders, summary],
  );
  const timeline = useMemo(
    () => (displaySummary ? fillUsageTimeline(displaySummary) : []),
    [displaySummary],
  );

  const headerActions = (
    <ToggleGroup
      aria-label="Select usage range"
      size="xs"
      variant="toolbar"
      value={[range]}
      onValueChange={(value) => {
        const nextRange = value[0];
        if (
          nextRange === "24h" ||
          nextRange === "7d" ||
          nextRange === "30d" ||
          nextRange === "all"
        ) {
          setRange(nextRange);
        }
      }}
    >
      {RANGE_OPTIONS.map((option) => (
        <Toggle key={option} aria-label={option} value={option}>
          {formatRangeOptionLabel(option)}
        </Toggle>
      ))}
    </ToggleGroup>
  );

  return (
    <StandaloneChatPageShell
      header={<StandaloneChatPageHeader actions={headerActions} title="Usage" />}
    >
      <StandalonePageContent contentClassName="flex flex-col gap-8">
        {error ? (
          <p role="alert" className="text-sm text-muted-foreground">
            Could not load usage: {error}
            {summary ? " Showing last successful data." : " Choose a range to retry."}
          </p>
        ) : null}
        <section aria-label="Overview" className="space-y-4">
          <h2>Overview</h2>
          {displaySummary ? (
            <>
              <UsageDataStatus summary={displaySummary} />
              <UsageOverviewCard summary={displaySummary} />
            </>
          ) : loading ? (
            <UsageSectionLoader overview label="Loading usage overview" />
          ) : null}
        </section>

        <section aria-label="Activity" className="space-y-4">
          <h2>Activity</h2>
          {!displaySummary ? (
            loading ? (
              <UsageSectionLoader activity label="Loading usage activity" />
            ) : null
          ) : timeline.length > 0 ? (
            <UsageTokenUsageCard
              key={displaySummary.range}
              summary={displaySummary}
              timeline={timeline}
            />
          ) : (
            <Card>
              <CardContent className="p-0">
                <Empty className="min-h-72">
                  <EmptyMedia variant="icon">
                    <UsageIcon className="size-4" />
                  </EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>No usage yet.</EmptyTitle>
                    <EmptyDescription>
                      Run a few turns and the chart will start filling in.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </CardContent>
            </Card>
          )}
        </section>

        <section aria-label="Providers & models" className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2>Providers &amp; models</h2>
            <ToggleGroup
              aria-label="Select providers and models view"
              size="xs"
              variant="toolbar"
              value={[breakdownView]}
              onValueChange={(value) => {
                const nextView = value[0];
                if (nextView === "trend" || nextView === "split") {
                  setBreakdownView(nextView);
                }
              }}
            >
              <Toggle aria-label="Trend" value="trend">
                Trend
              </Toggle>
              <Toggle aria-label="Split" value="split">
                Split
              </Toggle>
            </ToggleGroup>
          </div>
          <div className="grid gap-4">
            {(["providers", "models"] as const).map((field) => {
              const title = field === "providers" ? "Providers" : "Models";
              return displaySummary ? (
                <UsageBreakdownCard
                  key={field}
                  entries={displaySummary[field]}
                  field={field}
                  range={displaySummary.range}
                  timeline={timeline}
                  title={title}
                  totalTokens={displaySummary.totals.usedTokens}
                  view={breakdownView}
                />
              ) : loading ? (
                <UsageSectionLoader key={field} title={title} label={`Loading usage ${field}`} />
              ) : null;
            })}
          </div>
        </section>
        <UsageSubscriptionLimits limits={subscriptionLimits} loading={providersLoading} />
        {displaySummary ? (
          <section className="mt-8 space-y-4 text-xs text-muted-foreground">
            <UsageAccountingFooter summary={displaySummary} />
            <p>
              *Token counts are reported differently by each provider. bigbud normalizes available
              usage fields for comparison, but totals should be treated as directional rather than
              billing-accurate.
            </p>
            <UsageDefinitions />
          </section>
        ) : null}
      </StandalonePageContent>
    </StandaloneChatPageShell>
  );
}

function formatRangeOptionLabel(value: ServerUsageRange) {
  return value === "all" ? "All" : value;
}

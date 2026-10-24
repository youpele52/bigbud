import { CpuIcon, FlameIcon, SigmaIcon } from "lucide-react";
import { UsageIcon } from "./UsageIcon";
import { AiIcon } from "../AiIcon";
import { type ComponentType, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";

import { type ServerUsageRange } from "@bigbud/contracts";

import { usePageTitle } from "~/hooks/usePageTitle";
import { useServerProviders } from "~/rpc/serverState";
import { formatHumanReadableDate } from "~/utils/timestamp";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/provider/ProviderModelPicker.models";
import { Card, CardContent, CardHeader } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import { StandaloneChatPageHeader } from "../standalone/StandaloneChatPageHeader";
import { StandaloneChatPageShell } from "../standalone/StandaloneChatPageShell";
import { StandalonePageContent } from "../standalone/StandalonePageContent";
import { StandalonePageLoading } from "../standalone/StandalonePageLoading";
import { UsageBreakdownCard, type UsageBreakdownView } from "./UsageBreakdownCard";
import { UsageDataStatus } from "./UsageDataStatus";
import { formatCompactNumber } from "./UsagePage.format";
import { applyUsageDisplayLabels } from "./UsagePage.labels";
import { UsageTokenMixCard } from "./UsageTokenMixCard";
import { UsageSubscriptionLimits } from "./UsageSubscriptionLimits";
import { UsageStatCard } from "./UsagePage.stat";
import { UsageAccountingFooter } from "./UsageAccountingFooter";
import { usageSourceLabel } from "./UsageAccounting.logic";
import { hasUsagePageLimits, useUsagePageSummary } from "./UsagePage.loading";

const RANGE_OPTIONS: ReadonlyArray<ServerUsageRange> = ["24h", "7d", "30d", "all"];

const chartConfig = {
  usedTokens: { color: "var(--chart-2)", label: "Tokens" },
  cachedInputTokens: { color: "var(--chart-1)", label: "Cached" },
  inputTokens: { color: "var(--chart-2)", label: "Input" },
  outputTokens: { color: "var(--chart-3)", label: "Output" },
  reasoningOutputTokens: { color: "var(--chart-4)", label: "Reasoning" },
} as const;

export function UsagePage() {
  usePageTitle("Usage");

  const serverProviders = useServerProviders();
  const [range, setRange] = useState<ServerUsageRange>("7d");
  const { summary, loading, error } = useUsagePageSummary(range);
  const [breakdownView, setBreakdownView] = useState<UsageBreakdownView>("bar");
  const subscriptionLimits = serverProviders
    .filter((provider) => provider.enabled)
    .map((provider) => provider.usageLimits);
  const displaySummary = useMemo(
    () => (summary ? applyUsageDisplayLabels(summary, serverProviders) : null),
    [serverProviders, summary],
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
      <StandalonePageLoading
        loading={loading && !displaySummary && !hasUsagePageLimits(subscriptionLimits)}
        label="Loading usage"
      >
        <StandalonePageContent contentClassName="flex flex-col gap-8">
          {error ? (
            <p role="alert" className="text-sm text-muted-foreground">
              Could not load usage: {error}
              {summary ? " Showing last successful data." : " Choose a range to retry."}
            </p>
          ) : null}
          {loading && !displaySummary ? (
            <p role="status" className="text-xs text-muted-foreground">
              Loading usage summary
            </p>
          ) : null}
          {displaySummary ? (
            <>
              <section aria-label="Overview" className="space-y-4">
                <h2>Overview</h2>
                <UsageDataStatus summary={displaySummary} />
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <UsageStatCard
                    icon={SigmaIcon}
                    label="Total tokens"
                    sourceLabel={usageSourceLabel(displaySummary.totals.accounting)}
                    value={displaySummary.totals.usedTokens.toLocaleString()}
                  />
                  <UsageStatCard
                    icon={resolveUsageProviderIcon(displaySummary.favoriteProvider?.id ?? null)}
                    label="Top provider"
                    value={displaySummary.favoriteProvider?.label ?? "None"}
                  />
                  <UsageStatCard
                    icon={AiIcon}
                    label="Top model"
                    value={displaySummary.favoriteModel?.label ?? "None"}
                  />
                  <UsageStatCard
                    icon={FlameIcon}
                    label="Streak"
                    value={`${displaySummary.streakDays}d`}
                  />
                </div>
              </section>

              <section aria-label="Token usage" className="space-y-4">
                <h2>Token usage</h2>
                {displaySummary.buckets.length > 0 ? (
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                    <Card>
                      <CardHeader>
                        <h3>Over time</h3>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <ChartContainer className="h-80 min-h-80" config={chartConfig}>
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={displaySummary.buckets}>
                              <CartesianGrid
                                vertical={false}
                                stroke="var(--border)"
                                strokeOpacity={0.4}
                              />
                              <XAxis
                                axisLine={false}
                                dataKey="bucketStart"
                                minTickGap={24}
                                tickFormatter={(value) =>
                                  formatBucketAxisLabel(value, displaySummary.range)
                                }
                                tickLine={false}
                              />
                              <YAxis
                                axisLine={false}
                                tickFormatter={(value) => formatCompactNumber(value)}
                                tickLine={false}
                                width={48}
                              />
                              <ChartTooltip
                                cursor={{ fill: "var(--muted)", fillOpacity: 0.35 }}
                                content={
                                  <ChartTooltipContent
                                    labelFormatter={(value) =>
                                      `${formatBucketTooltipLabel(value, displaySummary.range)} ${usageSourceLabel(displaySummary.buckets.find((bucket) => bucket.bucketStart === value)?.accounting)}`
                                    }
                                  />
                                }
                              />
                              <Bar
                                dataKey="usedTokens"
                                fill="var(--color-usedTokens)"
                                name={chartConfig.usedTokens.label}
                                radius={[2, 2, 0, 0]}
                                stackId="usage"
                              />
                            </BarChart>
                          </ResponsiveContainer>
                        </ChartContainer>
                      </CardContent>
                    </Card>
                    <UsageTokenMixCard totals={displaySummary.totals} />
                  </div>
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

              <section aria-label="Breakdown" className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h2>Breakdown</h2>
                  <ToggleGroup
                    aria-label="Select breakdown chart view"
                    size="xs"
                    variant="toolbar"
                    value={[breakdownView]}
                    onValueChange={(value) => {
                      const nextView = value[0];
                      if (nextView === "bar" || nextView === "pie") {
                        setBreakdownView(nextView);
                      }
                    }}
                  >
                    <Toggle aria-label="Ranking" value="bar">
                      Ranking
                    </Toggle>
                    <Toggle aria-label="Share" value="pie">
                      Share
                    </Toggle>
                  </ToggleGroup>
                </div>

                <div
                  className={`grid gap-4 ${breakdownView === "pie" ? "grid-cols-1" : "lg:grid-cols-2"}`}
                >
                  <UsageBreakdownCard
                    entries={displaySummary.providers}
                    title="Providers"
                    totalTokens={displaySummary.totals.usedTokens}
                    view={breakdownView}
                  />
                  <UsageBreakdownCard
                    entries={displaySummary.models}
                    title="Models"
                    totalTokens={displaySummary.totals.usedTokens}
                    view={breakdownView}
                  />
                </div>
              </section>
            </>
          ) : null}
          <UsageSubscriptionLimits limits={subscriptionLimits} />
          {displaySummary ? (
            <section className="space-y-4 text-xs text-muted-foreground">
              <UsageAccountingFooter summary={displaySummary} />
              <p>
                *Token counts are reported differently by each provider. bigbud normalizes available
                usage fields for comparison, but totals should be treated as directional rather than
                billing-accurate.
              </p>
              <dl className="space-y-2">
                <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                  <dt className="font-medium text-foreground">Cached:</dt>
                  <dd>Input tokens reused from a provider cache.</dd>
                </div>
                <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                  <dt className="font-medium text-foreground">Input:</dt>
                  <dd>Tokens sent to the model, including your prompt and context.</dd>
                </div>
                <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                  <dt className="font-medium text-foreground">Output:</dt>
                  <dd>Tokens generated in the model response.</dd>
                </div>
                <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                  <dt className="font-medium text-foreground">Reasoning:</dt>
                  <dd>Tokens some models use for internal reasoning before answering.</dd>
                </div>
              </dl>
            </section>
          ) : null}
        </StandalonePageContent>
      </StandalonePageLoading>
    </StandaloneChatPageShell>
  );
}

function formatRangeOptionLabel(value: ServerUsageRange) {
  return value === "all" ? "All" : value;
}

function resolveUsageProviderIcon(
  providerId: string | null,
): ComponentType<{ className?: string }> {
  if (providerId && providerId in PROVIDER_ICON_BY_PROVIDER) {
    return PROVIDER_ICON_BY_PROVIDER[providerId as keyof typeof PROVIDER_ICON_BY_PROVIDER];
  }

  return CpuIcon;
}

function formatBucketAxisLabel(value: string, range: ServerUsageRange) {
  const date = new Date(value);
  if (range === "24h") {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(date);
  }
  if (range === "all") {
    return new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatBucketTooltipLabel(value: string, range: ServerUsageRange) {
  if (range === "all") {
    return formatHumanReadableDate(value, "month-year");
  }

  return formatHumanReadableDate(value, range === "24h" ? "date-time" : "date");
}

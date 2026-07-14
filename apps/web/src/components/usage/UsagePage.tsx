import { BarChart3Icon, BotIcon, CpuIcon, FlameIcon, SigmaIcon } from "lucide-react";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";

import { type ServerUsageRange, type ServerUsageSummaryResult } from "@bigbud/contracts";

import { usePageTitle } from "~/hooks/usePageTitle";
import { retryTransportRecoveryOperation } from "~/logic/orchestration/transport-retry.logic";
import { readNativeApi } from "~/rpc/nativeApi";
import { useServerProviders } from "~/rpc/serverState";
import { formatHumanReadableDate } from "~/utils/timestamp";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/provider/ProviderModelPicker.models";
import { BigbudLoader } from "../layout/BigbudLoader";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import { StandaloneChatPageHeader } from "../standalone/StandaloneChatPageHeader";
import { StandaloneChatPageShell } from "../standalone/StandaloneChatPageShell";
import { UsageBreakdownCard, type UsageBreakdownView } from "./UsageBreakdownCard";
import { formatCompactNumber } from "./UsagePage.format";
import { applyUsageDisplayLabels } from "./UsagePage.labels";
import { UsageTokenMixCard } from "./UsageTokenMixCard";

const RANGE_OPTIONS: ReadonlyArray<ServerUsageRange> = ["24h", "7d", "30d", "all"];

const chartConfig = {
  cachedInputTokens: { color: "var(--chart-1)", label: "Cached" },
  inputTokens: { color: "var(--chart-2)", label: "Input" },
  outputTokens: { color: "var(--chart-3)", label: "Output" },
  reasoningOutputTokens: { color: "var(--chart-4)", label: "Reasoning" },
} as const;

export function UsagePage() {
  usePageTitle("Usage");

  const api = readNativeApi();
  const serverProviders = useServerProviders();
  const [range, setRange] = useState<ServerUsageRange>("7d");
  const [summary, setSummary] = useState<ServerUsageSummaryResult | null>(null);
  const [breakdownView, setBreakdownView] = useState<UsageBreakdownView>("bar");
  const [loading, setLoading] = useState(true);
  const displaySummary = useMemo(
    () => (summary ? applyUsageDisplayLabels(summary, serverProviders) : null),
    [serverProviders, summary],
  );

  useEffect(() => {
    if (!api) {
      return;
    }

    let active = true;
    setLoading(true);
    void retryTransportRecoveryOperation(() => api.server.getUsageSummary({ range }), {
      maxRetries: 2,
      shouldAbort: () => !active,
    })
      .then((nextSummary) => {
        if (active) {
          setSummary(nextSummary);
        }
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        toastManager.add({
          type: "error",
          title: "Failed to load usage",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        setSummary(null);
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [api, range]);

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
      {loading ? (
        <section className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <BigbudLoader />
        </section>
      ) : (
        <section className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-4 px-4 py-6 sm:px-6">
            {displaySummary ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <UsageStatCard
                    icon={SigmaIcon}
                    label="Total tokens"
                    value={displaySummary.totals.usedTokens.toLocaleString()}
                  />
                  <UsageStatCard
                    icon={resolveUsageProviderIcon(displaySummary.favoriteProvider?.id ?? null)}
                    label="Top provider"
                    value={displaySummary.favoriteProvider?.label ?? "None"}
                  />
                  <UsageStatCard
                    icon={BotIcon}
                    label="Top model"
                    value={displaySummary.favoriteModel?.label ?? "None"}
                  />
                  <UsageStatCard
                    icon={FlameIcon}
                    label="Streak"
                    value={`${displaySummary.streakDays}d`}
                  />
                </div>

                {displaySummary.buckets.length > 0 ? (
                  <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                    <Card>
                      <CardHeader>
                        <CardTitle>Token usage</CardTitle>
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
                                      formatBucketTooltipLabel(value, displaySummary.range)
                                    }
                                  />
                                }
                              />
                              <Bar
                                dataKey="cachedInputTokens"
                                fill="var(--color-cachedInputTokens)"
                                name={chartConfig.cachedInputTokens.label}
                                radius={[2, 2, 0, 0]}
                                stackId="usage"
                              />
                              <Bar
                                dataKey="inputTokens"
                                fill="var(--color-inputTokens)"
                                name={chartConfig.inputTokens.label}
                                radius={[2, 2, 0, 0]}
                                stackId="usage"
                              />
                              <Bar
                                dataKey="outputTokens"
                                fill="var(--color-outputTokens)"
                                name={chartConfig.outputTokens.label}
                                radius={[2, 2, 0, 0]}
                                stackId="usage"
                              />
                              <Bar
                                dataKey="reasoningOutputTokens"
                                fill="var(--color-reasoningOutputTokens)"
                                name={chartConfig.reasoningOutputTokens.label}
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
                  <Card className="mt-4">
                    <CardContent className="p-0">
                      <Empty className="min-h-72">
                        <EmptyMedia variant="icon">
                          <BarChart3Icon className="size-4" />
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

                <section className="mt-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-foreground">Breakdown</h3>
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

                <section className="mt-24 space-y-4 text-xs text-muted-foreground">
                  <p>
                    <span className="mr-1">*</span>
                    Token counts are reported differently by each provider. bigbud normalizes
                    available usage fields for comparison, but totals should be treated as
                    directional rather than billing-accurate.
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
              </>
            ) : null}
          </div>
        </section>
      )}
    </StandaloneChatPageShell>
  );
}

function UsageStatCard({
  icon: Icon,
  label,
  value,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/50">
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="truncate text-sm font-medium text-foreground">{value}</div>
        </div>
      </CardContent>
    </Card>
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

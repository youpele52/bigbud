import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { CircleAlertIcon, ClockIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { formatHumanReadableDate } from "~/utils/timestamp";
import { StatusBanner } from "../common/StatusBanner";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  Progress,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
  ProgressValue,
} from "../ui/progress";
let claudeUsageUnavailableDismissed = false;

export function UsageSubscriptionLimits({
  limits,
}: {
  readonly limits: ServerProviderUsageLimits | undefined;
}) {
  const [isUnavailableDismissed, setIsUnavailableDismissed] = useState(
    () => claudeUsageUnavailableDismissed,
  );

  if (!limits) return null;

  const hasRetainedLimits = limits.status === "available" || limits.status === "stale";
  const showSectionHeading = limits.status !== "unavailable";

  return (
    <section aria-label="Claude subscription limits" className="space-y-3">
      {showSectionHeading ? (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-foreground">Claude subscription limits</h2>
          {limits.subscriptionType ? (
            <span className="text-xs capitalize text-muted-foreground">
              {limits.subscriptionType} subscription
            </span>
          ) : null}
        </div>
      ) : null}

      {limits.status === "stale" ? (
        <StatusBanner
          variant="warning"
          icon={<TriangleAlertIcon />}
          title="Subscription limits may be out of date"
          description={
            <>
              Showing the last successful values
              {limits.lastSuccessfulAt
                ? ` from ${formatHumanReadableDate(limits.lastSuccessfulAt, "date-time")}`
                : ""}
              .
            </>
          }
        />
      ) : null}

      {limits.status === "error" ? (
        <StatusBanner
          variant="error"
          icon={<CircleAlertIcon />}
          title="Couldn't load Claude subscription limits"
          description={limits.message ?? "Claude subscription limits could not be refreshed."}
        />
      ) : null}

      {limits.status === "pending" ? (
        <StatusBanner icon={<ClockIcon />} description="Checking Claude subscription limits..." />
      ) : null}

      {limits.status === "unavailable" && !isUnavailableDismissed ? (
        <StatusBanner
          variant="warning"
          icon={<TriangleAlertIcon />}
          title="Claude subscription limits"
          description="Claude subscription limits are unavailable for this account."
          dismissLabel="Dismiss Claude subscription limits"
          onDismiss={() => {
            claudeUsageUnavailableDismissed = true;
            setIsUnavailableDismissed(true);
          }}
        />
      ) : null}

      {hasRetainedLimits ? (
        <Card>
          <CardHeader>
            <CardTitle>Plan utilization</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {limits.windows.map((window) => (
              <Progress
                key={window.id}
                aria-label={window.label}
                aria-valuetext={`${Math.round(window.utilization)}% used`}
                value={window.utilization}
              >
                <div className="flex items-center gap-2">
                  <ProgressLabel>{window.label}</ProgressLabel>
                  <ProgressValue className="ml-auto">
                    {() => `${Math.round(window.utilization)}%`}
                  </ProgressValue>
                </div>
                <ProgressTrack>
                  <ProgressIndicator
                    className={usageIndicatorClassName(window.utilization, limits.status)}
                  />
                </ProgressTrack>
                {window.resetAt ? (
                  <div className="text-xs text-muted-foreground">
                    Resets {formatHumanReadableDate(window.resetAt, "date-time")}
                  </div>
                ) : null}
              </Progress>
            ))}
            {limits.extraUsage ? (
              <div className="space-y-1 text-sm">
                <div className="font-medium text-foreground">Extra usage</div>
                <div className="text-xs text-muted-foreground">
                  {formatExtraUsage(limits.extraUsage)}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

function usageIndicatorClassName(
  utilization: number,
  status: ServerProviderUsageLimits["status"],
): string {
  if (utilization >= 95) return "bg-destructive";
  if (status === "stale" || utilization >= 80) return "bg-warning";
  return "bg-info";
}

function formatExtraUsage(
  extraUsage: NonNullable<ServerProviderUsageLimits["extraUsage"]>,
): string {
  if (!extraUsage.enabled) return "Disabled";
  if (extraUsage.usedCredits !== undefined && extraUsage.monthlyLimit !== undefined) {
    const currency = extraUsage.currency ? ` ${extraUsage.currency}` : "";
    return `${extraUsage.usedCredits.toLocaleString()} of ${extraUsage.monthlyLimit.toLocaleString()}${currency} used`;
  }
  if (extraUsage.utilization !== undefined) {
    return `${Math.round(extraUsage.utilization)}% used`;
  }
  return "Enabled";
}

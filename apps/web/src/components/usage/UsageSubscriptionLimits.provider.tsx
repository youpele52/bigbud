import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { CircleAlertIcon, ClockIcon, TriangleAlertIcon } from "lucide-react";
import { formatHumanReadableDate } from "~/utils/timestamp";
import { StatusBanner } from "../common/StatusBanner";
import {
  extraUsageUtilization,
  formatExtraUsageRemaining,
  SUBSCRIPTION_PROVIDER_LABELS,
} from "./UsageSubscriptionLimits.logic";
import { UsageSubscriptionLimitProgress } from "./UsageSubscriptionLimits.progress";

export function UsageSubscriptionProviderLimits({
  limits,
}: {
  readonly limits: ServerProviderUsageLimits;
}) {
  const hasRetainedLimits = limits.status === "available" || limits.status === "stale";
  const title = `${SUBSCRIPTION_PROVIDER_LABELS[limits.source]} subscription limits`;
  const extraUtilization = limits.extraUsage ? extraUsageUtilization(limits.extraUsage) : undefined;

  return (
    <section aria-label={title} className="space-y-3 py-5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3>{SUBSCRIPTION_PROVIDER_LABELS[limits.source]}</h3>
        {limits.subscriptionType ? (
          <span className="text-xs capitalize text-muted-foreground">
            {limits.subscriptionType} subscription
          </span>
        ) : null}
      </div>
      {limits.source === "cursor-dashboard" ? (
        <p className="text-xs text-muted-foreground">
          Uses the account signed in to Cursor desktop.
        </p>
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
          title={`Couldn't load ${title}`}
          description={limits.message ?? `${title} could not be refreshed.`}
        />
      ) : null}
      {limits.status === "pending" ? (
        <StatusBanner icon={<ClockIcon />} description={`Checking ${title}...`} />
      ) : null}
      {hasRetainedLimits ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {limits.windows.map((window) => (
            <UsageSubscriptionLimitProgress
              key={window.id}
              label={window.label}
              utilization={window.utilization}
              resetAt={window.resetAt}
              status={limits.status}
            />
          ))}
          {limits.extraUsage ? (
            extraUtilization !== undefined ? (
              <UsageSubscriptionLimitProgress
                label="Extra usage"
                utilization={extraUtilization}
                status={limits.status}
                description={formatExtraUsageRemaining(limits.extraUsage)}
              />
            ) : (
              <div className="space-y-1 text-sm">
                <div className="font-medium text-foreground">Extra usage</div>
                <div className="text-xs text-muted-foreground">
                  {formatExtraUsageRemaining(limits.extraUsage)}
                </div>
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

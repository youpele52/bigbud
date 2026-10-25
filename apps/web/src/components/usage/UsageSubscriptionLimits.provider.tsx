import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import { StatusBanner } from "../common/StatusBanner";
import { CenteredStatus } from "../common/CenteredStatus";
import {
  extraUsageUtilization,
  formatExtraUsageRemaining,
  SUBSCRIPTION_PROVIDER_LABELS,
} from "./UsageSubscriptionLimits.logic";
import { UsageSubscriptionLimitProgress } from "./UsageSubscriptionLimits.progress";
import { UsageSubscriptionManualResets } from "./UsageSubscriptionLimits.resets";
import { formatSubscriptionTimestamp } from "./UsageSubscriptionLimits.timestamp";

export function UsageSubscriptionProviderLimits({
  limits,
  compact = false,
}: {
  readonly limits: ServerProviderUsageLimits;
  readonly compact?: boolean;
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
          dismissalKey={["subscription-limits", limits.source, "stale"]}
          dismissLabel={`Dismiss ${SUBSCRIPTION_PROVIDER_LABELS[limits.source]} stale subscription limits warning`}
          centered
          variant="warning"
          icon={<TriangleAlertIcon />}
          title="Subscription limits may be out of date"
          description={
            <>
              Showing the last successful values
              {limits.lastSuccessfulAt
                ? ` from ${formatSubscriptionTimestamp(limits.lastSuccessfulAt)}`
                : ""}
              .
            </>
          }
        />
      ) : null}
      {limits.status === "error" ? (
        <StatusBanner
          dismissalKey={["subscription-limits", limits.source, "error"]}
          dismissLabel={`Dismiss ${SUBSCRIPTION_PROVIDER_LABELS[limits.source]} subscription limits error`}
          centered
          variant="error"
          icon={<CircleAlertIcon />}
          title={`Couldn't load ${title}`}
          description={limits.message ?? `${title} could not be refreshed.`}
        />
      ) : null}
      {limits.status === "pending" ? (
        <CenteredStatus loading className="rounded-xl border px-3.5 py-3">
          Checking {title}
        </CenteredStatus>
      ) : null}
      {hasRetainedLimits ? (
        <div
          className={compact ? "grid gap-4 @min-[640px]:grid-cols-2" : "grid gap-4 sm:grid-cols-2"}
        >
          {limits.windows.map((window) => (
            <UsageSubscriptionLimitProgress
              key={window.id}
              label={window.label}
              utilization={window.utilization}
              resetAt={window.resetAt}
            />
          ))}
          {limits.extraUsage ? (
            extraUtilization !== undefined ? (
              <UsageSubscriptionLimitProgress
                label="Extra usage"
                utilization={extraUtilization}
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
      {hasRetainedLimits && limits.manualResets ? (
        <UsageSubscriptionManualResets resets={limits.manualResets} />
      ) : null}
    </section>
  );
}

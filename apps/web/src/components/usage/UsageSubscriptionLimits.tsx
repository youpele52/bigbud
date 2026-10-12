import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { Card, CardContent } from "../ui/card";
import { UsageSubscriptionProviderLimits } from "./UsageSubscriptionLimits.provider";
import { SUBSCRIPTION_PROVIDER_LABELS } from "./UsageSubscriptionLimits.logic";
import { CenteredStatus } from "../common/CenteredStatus";

export function UsageSubscriptionLimits({
  limits,
  compact = false,
}: {
  readonly limits: ReadonlyArray<ServerProviderUsageLimits | undefined>;
  readonly compact?: boolean;
}) {
  const supportedLimits = limits
    .filter(
      (limit): limit is ServerProviderUsageLimits =>
        limit !== undefined && limit.status !== "unavailable",
    )
    .toSorted((left, right) =>
      SUBSCRIPTION_PROVIDER_LABELS[left.source].localeCompare(
        SUBSCRIPTION_PROVIDER_LABELS[right.source],
      ),
    );
  if (supportedLimits.length === 0)
    return compact ? (
      <CenteredStatus>Subscription limits unavailable for enabled providers.</CenteredStatus>
    ) : null;

  return (
    <section aria-label="Subscription limits" className="space-y-4">
      <div className="space-y-1">
        <h2 className={compact ? "text-sm font-semibold" : undefined}>Subscription limits</h2>
        <p className="text-xs text-muted-foreground">
          {compact ? "Remaining allowance · provider-defined windows" : "Remaining allowance"}
        </p>
      </div>
      <Card>
        <CardContent className={compact ? "divide-y divide-border p-3" : "divide-y divide-border"}>
          {supportedLimits.map((limit) => (
            <UsageSubscriptionProviderLimits key={limit.source} limits={limit} compact={compact} />
          ))}
        </CardContent>
      </Card>
    </section>
  );
}

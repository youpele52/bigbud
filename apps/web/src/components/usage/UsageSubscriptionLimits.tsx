import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { Card, CardContent } from "../ui/card";
import { UsageSubscriptionProviderLimits } from "./UsageSubscriptionLimits.provider";
import { SUBSCRIPTION_PROVIDER_LABELS } from "./UsageSubscriptionLimits.logic";

export function UsageSubscriptionLimits({
  limits,
}: {
  readonly limits: ReadonlyArray<ServerProviderUsageLimits | undefined>;
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
  if (supportedLimits.length === 0) return null;

  return (
    <section aria-label="Subscription limits" className="space-y-4">
      <div className="space-y-1">
        <h2>Subscription limits</h2>
        <p className="text-xs text-muted-foreground">Remaining allowance</p>
      </div>
      <Card>
        <CardContent className="divide-y divide-border">
          {supportedLimits.map((limit) => (
            <UsageSubscriptionProviderLimits key={limit.source} limits={limit} />
          ))}
        </CardContent>
      </Card>
    </section>
  );
}

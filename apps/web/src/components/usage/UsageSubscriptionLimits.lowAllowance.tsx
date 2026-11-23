import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  formatRemainingAllowance,
  remainingAllowancePercent,
  SUBSCRIPTION_PROVIDER_LABELS,
} from "./UsageSubscriptionLimits.logic";

export function UsageSubscriptionLowAllowance({
  limits,
}: {
  readonly limits: ReadonlyArray<ServerProviderUsageLimits>;
}) {
  const low = limits.flatMap((limit) =>
    limit.status === "available"
      ? limit.windows.flatMap((window) => {
          if (!["five-hour", "seven-day", "monthly"].includes(window.kind)) return [];
          const remaining = remainingAllowancePercent(window.utilization);
          return remaining <= 10 ? [{ source: limit.source, window, remaining }] : [];
        })
      : [],
  );
  if (!low.length) return null;

  return (
    <Alert variant="warning" role="group" aria-label="Subscription allowance warning">
      <AlertTitle>
        {low.some(({ remaining }) => remaining <= 5)
          ? "Subscription allowance nearly exhausted"
          : "Subscription allowance running low"}
      </AlertTitle>
      <AlertDescription>
        <ul>
          {low.map(({ source, window, remaining }) => (
            <li key={`${source}:${window.id}`}>
              {SUBSCRIPTION_PROVIDER_LABELS[source]} · {window.label}:{" "}
              {formatRemainingAllowance(remaining)}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

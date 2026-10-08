import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { formatHumanReadableDate } from "~/utils/timestamp";
import {
  Progress,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
  ProgressValue,
} from "../ui/progress";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  formatAllowanceUsage,
  formatRemainingAllowance,
  remainingAllowanceClassName,
  remainingAllowancePercent,
} from "./UsageSubscriptionLimits.logic";

/** Displays the same remaining-allowance semantics for quota windows and extra spending caps. */
export function UsageSubscriptionLimitProgress({
  label,
  utilization,
  status,
  resetAt,
  description,
}: {
  readonly label: string;
  readonly utilization: number;
  readonly status: ServerProviderUsageLimits["status"];
  readonly resetAt?: string | undefined;
  readonly description?: string | undefined;
}) {
  const remaining = remainingAllowancePercent(utilization);
  const valueText = formatRemainingAllowance(remaining);
  const usageDetails = formatAllowanceUsage(utilization);
  return (
    <Tooltip>
      <TooltipTrigger
        tabIndex={0}
        className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        render={
          <Progress
            aria-label={label}
            aria-valuetext={valueText}
            aria-description={usageDetails}
            value={remaining}
          />
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <ProgressLabel>{label}</ProgressLabel>
          <ProgressValue className="ml-auto text-foreground">{() => valueText}</ProgressValue>
        </div>
        <ProgressTrack>
          <ProgressIndicator className={remainingAllowanceClassName(remaining, status)} />
        </ProgressTrack>
        {resetAt ? (
          <div className="text-xs text-muted-foreground">
            Resets {formatHumanReadableDate(resetAt, "date-time")}
          </div>
        ) : null}
        {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      </TooltipTrigger>
      <TooltipPopup>{usageDetails}</TooltipPopup>
    </Tooltip>
  );
}

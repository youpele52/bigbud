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
  remainingAllowanceColor,
  remainingAllowancePercent,
} from "./UsageSubscriptionLimits.logic";
import { formatSubscriptionTimestamp } from "./UsageSubscriptionLimits.timestamp";

/** Displays the same remaining-allowance semantics for quota windows and extra spending caps. */
export function UsageSubscriptionLimitProgress({
  label,
  utilization,
  resetAt,
  description,
}: {
  readonly label: string;
  readonly utilization: number;
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
          <ProgressIndicator style={{ backgroundColor: remainingAllowanceColor(remaining) }} />
        </ProgressTrack>
        {resetAt ? (
          <div className="text-xs text-muted-foreground">
            Resets {formatSubscriptionTimestamp(resetAt)}
          </div>
        ) : null}
        {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      </TooltipTrigger>
      <TooltipPopup>{usageDetails}</TooltipPopup>
    </Tooltip>
  );
}

import type {
  ServerProviderExtraUsage,
  ServerProviderUsageLimits,
} from "@bigbud/contracts/server/usageLimits.ts";
import { usagePercentColor } from "../ui/usageBands.logic";

export const SUBSCRIPTION_PROVIDER_LABELS: Record<ServerProviderUsageLimits["source"], string> = {
  "claude-agent-sdk": "Claude",
  "codex-app-server": "Codex",
  "cursor-dashboard": "Cursor",
  "opencode-go-api": "OpenCode Go",
};

/** Provider snapshots store percent used; every allowance display uses its bounded complement. */
export function remainingAllowancePercent(utilization: number): number {
  return Math.max(0, Math.min(100, 100 - utilization));
}

export function formatRemainingAllowance(remaining: number): string {
  return `${formatAllowancePercent(remaining)} remaining`;
}

/** Keeps rounded tooltip percentages complementary and consistent with the visible remaining value. */
export function formatAllowanceUsage(utilization: number): string {
  const remaining = Math.round(remainingAllowancePercent(utilization) * 10) / 10;
  return `${formatAllowancePercent(100 - remaining)} used · ${formatAllowancePercent(remaining)} left`;
}

function formatAllowancePercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

/** Color expresses used capacity, while the bar and accessible value still express remaining quota. */
export function remainingAllowanceColor(remaining: number): string {
  return usagePercentColor(100 - remaining);
}

/** Derives extra-usage utilization only when the provider reports a finite allowance. */
export function extraUsageUtilization(extra: ServerProviderExtraUsage): number | undefined {
  if (!extra.enabled) return undefined;
  if (extra.utilization !== undefined) return extra.utilization;
  if (
    extra.usedCredits === undefined ||
    extra.monthlyLimit === undefined ||
    extra.monthlyLimit <= 0
  )
    return undefined;
  return (extra.usedCredits / extra.monthlyLimit) * 100;
}

export function formatExtraUsageRemaining(extra: ServerProviderExtraUsage): string {
  if (!extra.enabled) return "Disabled";
  if (
    extra.usedCredits !== undefined &&
    extra.monthlyLimit !== undefined &&
    extra.monthlyLimit > 0
  ) {
    const remaining = Math.max(0, extra.monthlyLimit - extra.usedCredits);
    const currency = extra.currency ? ` ${extra.currency}` : "";
    return `${remaining.toLocaleString()} of ${extra.monthlyLimit.toLocaleString()}${currency} remaining`;
  }
  return "Enabled";
}

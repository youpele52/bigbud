import type { ServerProviderUsageLimitWindow } from "@bigbud/contracts/server/usageLimits.ts";
import {
  availableUsageLimits,
  usageNumber,
  usagePercent,
  usageRecord,
  usageResetAt,
  usageString,
} from "../../providerUsageLimits.ts";

/** Maps Cursor's dashboard allowance, never treating missing usage as zero. */
export function normalizeCursorUsageLimits(value: unknown, checkedAt: string) {
  const response = usageRecord(value);
  const windows: ServerProviderUsageLimitWindow[] = [];
  const resetAt = usageResetAt(response.billingCycleEnd);
  const individual =
    response.individualUsage == null ? undefined : usageRecord(response.individualUsage);
  const plan = individual?.plan == null ? undefined : usageRecord(individual.plan);
  const overall = individual?.overall == null ? undefined : usageRecord(individual.overall);
  const team = response.teamUsage == null ? undefined : usageRecord(response.teamUsage);
  const pooled = team?.pooled == null ? undefined : usageRecord(team.pooled);
  // Personal caps take precedence over the shared team pool and ordinary plan allowance.
  const personalPercent = allowancePercent(overall);
  const poolPercent = allowancePercent(pooled);
  const planPercent =
    plan?.enabled === false
      ? undefined
      : (usagePercent(plan?.totalPercentUsed) ?? allowancePercent(plan));
  const total = personalPercent ?? poolPercent ?? planPercent;
  if (total !== undefined) {
    windows.push(
      makeWindow(
        "monthly",
        personalPercent !== undefined
          ? "Personal monthly limit"
          : poolPercent !== undefined
            ? "Team monthly limit"
            : "Monthly plan limit",
        total,
        resetAt,
      ),
    );
  }
  if (plan?.enabled !== false && personalPercent === undefined && poolPercent === undefined) {
    for (const [field, label] of [
      ["autoPercentUsed", "Auto + Composer"],
      ["apiPercentUsed", "Named models"],
    ] as const) {
      const percent = usagePercent(plan?.[field]);
      if (percent !== undefined) windows.push(makeWindow(field, label, percent, resetAt));
    }
  }
  const onDemand = individual?.onDemand == null ? undefined : usageRecord(individual.onDemand);
  const extraUsed = usageNumber(onDemand?.used);
  const extraLimit = usageNumber(onDemand?.limit);
  const extraUsage =
    onDemand && typeof onDemand.enabled === "boolean"
      ? {
          enabled: onDemand.enabled,
          ...(extraUsed === undefined ? {} : { usedCredits: extraUsed / 100 }),
          ...(extraLimit === undefined ? {} : { monthlyLimit: extraLimit / 100 }),
          currency: "USD",
        }
      : undefined;
  const subscriptionType = usageString(response.membershipType);
  return availableUsageLimits("cursor-dashboard", checkedAt, windows, {
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(extraUsage ? { extraUsage } : {}),
  });
}

function allowancePercent(allowance: Record<string, unknown> | undefined): number | undefined {
  if (!allowance || allowance.enabled === false) return undefined;
  const used = usageNumber(allowance.used);
  const limit = usageNumber(allowance.limit);
  return used !== undefined && limit !== undefined && limit > 0
    ? Math.min(100, (used / limit) * 100)
    : undefined;
}

function makeWindow(
  id: string,
  label: string,
  utilization: number,
  resetAt: string | undefined,
): ServerProviderUsageLimitWindow {
  return { id, kind: "monthly", label, utilization, ...(resetAt ? { resetAt } : {}) };
}

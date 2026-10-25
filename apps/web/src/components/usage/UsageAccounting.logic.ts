import type { ServerUsageTotals, UsageSourceMetadata } from "@bigbud/contracts/server/usage.ts";
import { reconciledUsageTokenMix, unsplitUsageTokenMix } from "@bigbud/shared/usageTokenMix";

export function usageSourceLabel(
  accounting: Pick<UsageSourceMetadata, "source"> | undefined,
): string {
  if (!accounting) return "Source unavailable";
  return accounting.source === "estimated"
    ? "Estimated"
    : accounting.source === "mixed"
      ? "Mixed"
      : "";
}

/** Never infer category detail from old-server numeric counters or null-poisoned aggregates. */
export function disjointUsageMix(totals: Pick<ServerUsageTotals, "usedTokens" | "tokenMix">) {
  return (
    reconciledUsageTokenMix(totals.tokenMix, totals.usedTokens) ??
    unsplitUsageTokenMix(totals.usedTokens)
  );
}

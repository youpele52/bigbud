import type { ServerUsageBucketShare } from "@bigbud/contracts/server/usage.ts";

/** Bucket start -> provider or model id -> tokens, so the UI can chart each one over time. */
export type UsageBucketShareTally = Map<string, Map<string, number>>;

export function tallyUsageBucketShare(
  tally: UsageBucketShareTally,
  bucketStart: string,
  id: string,
  usedTokens: number,
) {
  const shares = tally.get(bucketStart) ?? new Map<string, number>();
  shares.set(id, (shares.get(id) ?? 0) + usedTokens);
  tally.set(bucketStart, shares);
}

/** Ranked like the summary breakdowns: most tokens first, then id for a stable order. */
export function usageBucketShares(
  tally: UsageBucketShareTally,
  bucketStart: string,
): ServerUsageBucketShare[] {
  return Array.from(tally.get(bucketStart) ?? [], ([id, usedTokens]) => ({
    id,
    usedTokens,
  })).toSorted(
    (left, right) => right.usedTokens - left.usedTokens || left.id.localeCompare(right.id),
  );
}

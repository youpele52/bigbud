import { expect, it } from "vitest";
import { disjointUsageMix, usageSourceLabel } from "./UsageAccounting.logic";

it("never labels old-server data official or trusts legacy zero defaults", () => {
  expect(usageSourceLabel(undefined)).toBe("Source unavailable");
  expect(disjointUsageMix({ usedTokens: 100 })).toEqual({
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    unclassifiedTokens: 100,
  });
});

it("uses per-contribution derived metadata even when canonical categories are unknown", () => {
  const tokenMix = {
    inputTokens: 50,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    outputTokens: 30,
    unclassifiedTokens: 5,
  };
  expect(usageSourceLabel({ source: "mixed" })).toBe("Mixed");
  expect(disjointUsageMix({ usedTokens: 115, tokenMix })).toEqual(tokenMix);
  expect(disjointUsageMix({ usedTokens: 116, tokenMix }).unclassifiedTokens).toBe(116);
  expect(disjointUsageMix({ usedTokens: 0 }).unclassifiedTokens).toBe(0);
});

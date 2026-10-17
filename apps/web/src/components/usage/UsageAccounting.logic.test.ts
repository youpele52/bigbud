import { expect, it } from "vitest";
import { disjointUsageMix, usageSourceLabel } from "./UsageAccounting.logic";

it("never labels old-server data official", () => {
  expect(usageSourceLabel(undefined)).toBe("Source unavailable");
  expect(disjointUsageMix(undefined)).toBeUndefined();
});
it("uses disjoint verified subsets and refuses unknown relationships", () => {
  const accounting = {
    source: "mixed" as const,
    partial: false,
    legacy: false,
    reportedTokens: 100,
    estimatedTokens: 10,
    inputTokens: 80,
    outputTokens: 30,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    reasoningTokens: 5,
  };
  expect(usageSourceLabel(accounting)).toBe("Mixed");
  expect(disjointUsageMix(accounting)).toEqual({
    inputTokens: 50,
    cachedInputTokens: 20,
    cacheWriteTokens: 10,
    outputTokens: 25,
    reasoningOutputTokens: 5,
  });
  expect(disjointUsageMix({ ...accounting, cacheWriteTokens: null })).toBeUndefined();
});

import { expect, it } from "vitest";
import {
  summarizeUsageAccounting,
  summarizeUsageSources,
} from "./wsRpcHandlers.usage.accounting.ts";

it("marks selected mixed and legacy rows without capability-derived provenance", () => {
  const estimated = {
    version: 2,
    source: "estimated",
    basis: "observable-text-v1",
    completeness: "partial",
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    reportedTotal: null,
    subtotal: 5,
  };
  expect(
    summarizeUsageSources([
      { usedTokens: 5, source: "estimated", accountingJson: JSON.stringify(estimated) },
      { usedTokens: 10 },
    ]),
  ).toMatchObject({
    source: "mixed",
    partial: true,
    legacy: true,
    estimatedTokens: 5,
    reportedTokens: 10,
    inputTokens: null,
  });
  expect(summarizeUsageSources([]).source).toBe("none");
  expect(summarizeUsageAccounting([]).tokenMix).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unclassifiedTokens: 0,
  });
});
it("keeps observed official zero as official provenance and rejects aggregate overflow", () => {
  expect(summarizeUsageSources([{ usedTokens: 0, source: "provider-reported" }]).source).toBe(
    "provider-reported",
  );
  expect(() =>
    summarizeUsageSources([{ usedTokens: Number.MAX_SAFE_INTEGER }, { usedTokens: 1 }]),
  ).toThrow("safe integer");
  expect(() =>
    summarizeUsageSources([
      { usedTokens: Number.MAX_SAFE_INTEGER, source: "provider-reported" },
      { usedTokens: 1, source: "estimated" },
    ]),
  ).toThrow("safe integer");
});

it("accumulates usable contributions before legacy/null propagation and preserves every total", () => {
  const canonical = {
    version: 2,
    source: "provider-reported",
    basis: "test",
    completeness: "partial",
    inputTokens: 80,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: null,
    reasoningTokens: null,
    reportedTotal: 100,
    subtotal: 100,
  };
  const { accounting, tokenMix } = summarizeUsageAccounting([
    { usedTokens: 100, accountingJson: JSON.stringify(canonical) },
    {
      usedTokens: 5,
      source: "estimated",
      accountingJson: JSON.stringify({
        ...canonical,
        source: "estimated",
        basis: "observable-text-v1",
        inputTokens: 3,
        outputTokens: 2,
        cacheReadTokens: null,
        reportedTotal: null,
        subtotal: 5,
      }),
    },
    { usedTokens: 7 },
    { usedTokens: 100, accountingJson: JSON.stringify({ ...canonical, cacheReadTokens: 81 }) },
    { usedTokens: 9, accountingJson: "{malformed" },
    { usedTokens: 0 },
  ]);
  expect(tokenMix).toEqual({
    inputTokens: 53,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    outputTokens: 22,
    unclassifiedTokens: 116,
  });
  expect(Object.values(tokenMix!).reduce((sum, count) => sum + count, 0)).toBe(221);
  expect(accounting).toMatchObject({
    source: "mixed",
    partial: true,
    legacy: true,
    inputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    reportedTokens: 216,
    estimatedTokens: 5,
  });
});

it("zero-only unknown rows do not null-poison other contributions' chart buckets", () => {
  const known = {
    version: 2,
    source: "provider-reported",
    basis: "test",
    completeness: "partial",
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    reportedTotal: 5,
    subtotal: 5,
  };
  const result = summarizeUsageAccounting([
    { usedTokens: 0 },
    { usedTokens: 5, accountingJson: JSON.stringify(known) },
  ]);
  expect(result.accounting.inputTokens).toBeNull();
  expect(result.tokenMix).toEqual({
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unclassifiedTokens: 0,
  });
});

it("omits derived arithmetic when only canonical group metadata is requested", () => {
  expect(summarizeUsageAccounting([{ usedTokens: 10 }], false)).toMatchObject({
    accounting: { reportedTokens: 10, inputTokens: null },
    tokenMix: undefined,
  });
});

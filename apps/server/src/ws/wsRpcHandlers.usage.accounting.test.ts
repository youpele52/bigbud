import { expect, it } from "vitest";
import { summarizeUsageSources } from "./wsRpcHandlers.usage.accounting.ts";

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

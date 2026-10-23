import { expect, it } from "vitest";
import type { UsageAccountingV2 } from "@bigbud/contracts/orchestration/providerRuntime.usage";
import {
  contributionTokenMix,
  reconciledUsageTokenMix,
  unsplitUsageTokenMix,
} from "./usageTokenMix";

function canonical(overrides: Partial<UsageAccountingV2> = {}): UsageAccountingV2 {
  return {
    version: 2,
    source: "provider-reported",
    basis: "test",
    completeness: "partial",
    inputTokens: 80,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
    reasoningTokens: null,
    subtotal: 100,
    reportedTotal: null,
    ...overrides,
  };
}

it("splits the real Claude sample without requiring reasoning", () => {
  expect(
    contributionTokenMix(
      1089163,
      canonical({
        inputTokens: 1079707,
        outputTokens: 9456,
        cacheReadTokens: 1068867,
        cacheWriteTokens: 10832,
        subtotal: 1089163,
      }),
    ),
  ).toEqual({
    inputTokens: 8,
    cacheReadTokens: 1068867,
    cacheWriteTokens: 10832,
    outputTokens: 9456,
    unclassifiedTokens: 0,
  });
});

it("keeps reasoning inside output for complete records", () => {
  expect(
    contributionTokenMix(100, canonical({ completeness: "complete", reasoningTokens: 5 })),
  ).toEqual({
    inputTokens: 40,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
    outputTokens: 20,
    unclassifiedTokens: 0,
  });
});

it("separates Codex known read while retaining unknown write in Input", () => {
  expect(contributionTokenMix(100, canonical({ cacheWriteTokens: null }))).toEqual({
    inputTokens: 50,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    outputTokens: 20,
    unclassifiedTokens: 0,
  });
});

it("uses Pi input/output with unknown reasoning and both cache subsets", () => {
  expect(
    contributionTokenMix(100, canonical({ cacheReadTokens: null, cacheWriteTokens: null })),
  ).toEqual({
    inputTokens: 80,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 20,
    unclassifiedTokens: 0,
  });
});

it("keeps observable-text-v1 estimates known input/output without inventing cache", () => {
  expect(
    contributionTokenMix(
      100,
      canonical({
        source: "estimated",
        basis: "observable-text-v1",
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }),
    ),
  ).toEqual({
    inputTokens: 80,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unclassifiedTokens: 0,
  });
});

it.each([
  { source: "legacy" as const },
  { source: "estimated" as const, basis: "unrecognized" },
  { inputTokens: null },
  { outputTokens: null },
  { subtotal: 101 },
  { reportedTotal: 101 },
  { inputTokens: 79 },
  { cacheReadTokens: 81 },
  { cacheWriteTokens: 51 },
  { reasoningTokens: 21 },
  { cacheReadTokens: -1 },
  { outputTokens: 20.5 },
  { cacheWriteTokens: Number.MAX_SAFE_INTEGER + 1 },
  { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
])("retains inconsistent or unsafe detail as unsplit: %j", (overrides) => {
  expect(contributionTokenMix(100, canonical(overrides))).toEqual(unsplitUsageTokenMix(100));
});

it("preserves unknown and observed zero without inventing detail", () => {
  expect(contributionTokenMix(100, undefined)).toEqual(unsplitUsageTokenMix(100));
  expect(contributionTokenMix(0, undefined)).toEqual(unsplitUsageTokenMix(0));
  expect(
    contributionTokenMix(
      0,
      canonical({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedTotal: 0,
        subtotal: 0,
      }),
    ),
  ).toEqual(unsplitUsageTokenMix(0));
  expect(() => contributionTokenMix(Number.MAX_SAFE_INTEGER + 1, undefined)).toThrow(
    "safe integer",
  );
});

it("validates derived metadata rather than clipping/rescaling a mismatch", () => {
  const mix = contributionTokenMix(100, canonical());
  expect(reconciledUsageTokenMix(mix, 100)).toEqual(mix);
  for (const invalid of [
    undefined,
    null,
    {},
    { ...mix, inputTokens: -1 },
    { ...mix, outputTokens: 21 },
    { ...mix, unclassifiedTokens: "0" },
    { ...mix, inputTokens: 40.5 },
    { ...mix, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
  ])
    expect(reconciledUsageTokenMix(invalid, 100)).toBeUndefined();
});

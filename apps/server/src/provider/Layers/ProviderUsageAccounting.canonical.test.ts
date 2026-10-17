import { describe, expect, it } from "vitest";
import {
  canonicalUsage,
  sumUsageCounters,
  usageCounter,
} from "./ProviderUsageAccounting.canonical.ts";
import { makeTokenUsageAccounting } from "./ProviderUsageAccounting.ts";
import { claudeCanonicalUsage } from "./Claude/Adapter.usage.ts";
import { normalizeOpencodeUsage } from "./Opencode/Adapter.usage.ts";

describe("canonical usage counters", () => {
  it("rejects fractional, negative, nonfinite and unsafe counters", () => {
    for (const value of [-1, 1.2, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, undefined])
      expect(usageCounter(value)).toBeNull();
    expect(sumUsageCounters(Number.MAX_SAFE_INTEGER, 1)).toBeNull();
    expect(sumUsageCounters(2, null)).toBeNull();
  });
  it("keeps observed zero distinct from unknown", () => {
    expect(canonicalUsage({ basis: "test" })).toBeUndefined();
    expect(canonicalUsage({ basis: "test", inputTokens: 0, outputTokens: 0 })).toMatchObject({
      subtotal: 0,
      inputTokens: 0,
      cacheReadTokens: null,
    });
    expect(
      makeTokenUsageAccounting({ scope: "turn", scopeId: "zero", usage: { usedTokens: 0 } })
        ?.processedTokens,
    ).toBe(0);
  });
  it("includes cache in Claude input exactly once and preserves reasoning unknown", () => {
    expect(
      claudeCanonicalUsage({
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        output_tokens: 5,
      }),
    ).toMatchObject({
      inputTokens: 60,
      outputTokens: 5,
      subtotal: 65,
      cacheReadTokens: 20,
      cacheWriteTokens: 30,
      reasoningTokens: null,
    });
  });
  it("does not treat per-step Claude output placeholders as consumption", () => {
    expect(
      claudeCanonicalUsage(
        {
          input_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 999,
        },
        true,
      ),
    ).toMatchObject({ outputTokens: null, subtotal: 10, completeness: "partial" });
  });
  it("keeps OpenCode cache write and unresolved reasoning without blind addition", () => {
    expect(
      normalizeOpencodeUsage({
        input: 10,
        output: 5,
        reasoning: 30,
        cache: { read: 20, write: 40 },
      })?.canonical,
    ).toMatchObject({
      subtotal: 75,
      cacheWriteTokens: 40,
      outputTokens: null,
      reasoningTokens: null,
      raw: { reasoning: 30 },
    });
  });
});

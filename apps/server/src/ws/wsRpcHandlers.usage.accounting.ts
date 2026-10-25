import { Schema } from "effect";
import { UsageAccountingV2 } from "@bigbud/contracts/orchestration/providerRuntime.usage";
import type { UsageSourceMetadata } from "@bigbud/contracts/server/usage.ts";
import {
  contributionTokenMix,
  unsplitUsageTokenMix,
  usageTokenMixKeys,
} from "@bigbud/shared/usageTokenMix";

type Entry = {
  readonly usedTokens: number;
  readonly source?: "estimated" | "provider-reported";
  readonly accountingJson?: string | null;
};
const keys = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;

/** Aggregate provenance from selected contributions, never from provider capability declarations. */
export function summarizeUsageSources(entries: readonly Entry[]): UsageSourceMetadata {
  return summarizeUsageAccounting(entries, false).accounting;
}

export function summarizeUsageAccounting(entries: readonly Entry[], includeTokenMix = true) {
  const tokenMix = includeTokenMix ? { ...unsplitUsageTokenMix(0) } : undefined;
  const result: UsageSourceMetadata = {
    source: "none",
    partial: false,
    legacy: false,
    reportedTokens: 0,
    estimatedTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  const mutable = { ...result };
  let estimated = false;
  let reported = false;
  for (const entry of entries) {
    let canonical: UsageAccountingV2 | undefined;
    if (entry.accountingJson) {
      try {
        const value: unknown = JSON.parse(entry.accountingJson);
        if (Schema.is(UsageAccountingV2)(value)) canonical = value;
      } catch {
        /* Old or malformed metadata must not manufacture a breakdown. */
      }
    }
    if (tokenMix) {
      const mix = contributionTokenMix(entry.usedTokens, canonical);
      for (const key of usageTokenMixKeys) {
        tokenMix[key] += mix[key];
        if (!Number.isSafeInteger(tokenMix[key]))
          throw new Error("Usage aggregate exceeds safe integer range");
      }
    }
    if (entry.source === "estimated") {
      estimated = true;
      mutable.estimatedTokens += entry.usedTokens;
    } else {
      reported = true;
      mutable.reportedTokens += entry.usedTokens;
    }
    mutable.legacy ||= !canonical || canonical.source === "legacy";
    mutable.partial ||= !canonical || canonical.completeness === "partial";
    for (const key of keys) {
      const value = canonical?.[key] ?? null;
      mutable[key] = mutable[key] === null || value === null ? null : mutable[key] + value;
    }
  }
  for (const value of [
    mutable.reportedTokens + mutable.estimatedTokens,
    mutable.reportedTokens,
    mutable.estimatedTokens,
    ...keys.map((key) => mutable[key]),
  ]) {
    if (value !== null && !Number.isSafeInteger(value))
      throw new Error("Usage aggregate exceeds safe integer range");
  }
  const accounting: UsageSourceMetadata = {
    ...mutable,
    source: estimated
      ? reported
        ? "mixed"
        : "estimated"
      : reported
        ? "provider-reported"
        : "none",
  };
  return { accounting, tokenMix };
}

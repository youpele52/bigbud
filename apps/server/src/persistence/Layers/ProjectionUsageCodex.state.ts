import { Schema } from "effect";
import { UsageAccountingV2 } from "@bigbud/contracts/orchestration/providerRuntime.usage";
import type { CodexUsageState } from "./ProjectionUsageCodex.reducer.ts";

const State = Schema.Struct({
  nativeThreadId: Schema.String,
  turnId: Schema.String,
  total: UsageAccountingV2,
  amount: UsageAccountingV2,
  measured: Schema.optional(Schema.Boolean),
  fingerprints: Schema.optional(Schema.Array(Schema.String)),
  retired: Schema.optional(Schema.Array(Schema.String)),
});
const counters = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "reportedTotal",
  "subtotal",
] as const;

/** Upgrade older checkpoints/baselines once, preserving their highest observed counters. */
export function decodeCodexState(json: string): {
  state: CodexUsageState;
  retired: readonly string[];
  upgraded: boolean;
} {
  const decoded = Schema.decodeUnknownSync(State)(JSON.parse(json));
  const total = { ...decoded.total };
  for (const fingerprint of decoded.fingerprints ?? []) {
    const observation: unknown = JSON.parse(fingerprint);
    if (
      !Array.isArray(observation) ||
      observation[0] !== decoded.nativeThreadId ||
      !Schema.is(UsageAccountingV2)(observation[1])
    )
      continue;
    for (const key of counters) {
      const value = observation[1][key];
      if (value !== null && (total[key] === null || value > total[key]!)) total[key] = value;
    }
  }
  return {
    state: {
      nativeThreadId: decoded.nativeThreadId,
      turnId: decoded.turnId,
      total,
      amount: decoded.amount,
      measured:
        decoded.measured ??
        (decoded.amount.subtotal > 0 ||
          counters.some((key) => key !== "subtotal" && decoded.amount[key] !== null)),
    },
    retired: decoded.retired ?? [],
    upgraded: decoded.fingerprints !== undefined || decoded.retired !== undefined,
  };
}

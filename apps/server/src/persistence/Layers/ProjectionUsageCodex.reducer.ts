import type {
  CodexUsageObservation,
  UsageAccountingV2,
} from "@bigbud/contracts/orchestration/providerRuntime.usage";

export interface CodexUsageState {
  readonly nativeThreadId: string;
  readonly turnId: string;
  readonly total: UsageAccountingV2;
  readonly amount: UsageAccountingV2;
  readonly measured: boolean;
}
const counters = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "reportedTotal",
  "subtotal",
] as const;

/** Conservative cumulative reducer. Process epochs do not imply counter resets. */
export function reduceCodexUsage(
  state: CodexUsageState | undefined,
  turnId: string,
  observation: CodexUsageObservation,
  existing?: UsageAccountingV2,
): CodexUsageState | undefined {
  const sameTurn = state?.turnId === turnId;
  const sameNative = state?.nativeThreadId === observation.nativeThreadId;
  let amount: UsageAccountingV2;
  let measured = existing !== undefined || observation.last !== undefined;
  if (!state || !sameTurn) {
    amount = existing ??
      observation.last ?? {
        version: 2,
        source: "provider-reported",
        basis: "codex-cumulative-delta",
        completeness: "partial",
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        reportedTotal: null,
        subtotal: 0,
      };
  } else {
    amount = { ...state.amount };
    // A decrease is indistinguishable from delayed delivery. Never lower the high-water
    // mark without explicit reset evidence (a process epoch is not such evidence).
    const monotonic =
      sameNative &&
      counters.every((key) => {
        const before = state.total[key];
        const after = observation.total[key];
        return before === null || after === null || after >= before;
      });
    if (!monotonic) return undefined;
    const unchanged = counters.every((key) => state.total[key] === observation.total[key]);
    if (!state.measured && !existing && observation.last) {
      // A cumulative baseline alone did not establish consumption, even if its subtotal
      // was zero. A newly available last response is evidence, not a duplicate.
      amount = observation.last;
      measured = true;
    } else {
      if (unchanged) return undefined;
      const next = { ...amount };
      for (const key of counters) {
        const before = state.total[key];
        const after = observation.total[key];
        const accumulated = amount[key];
        const value =
          before === null || after === null || accumulated === null
            ? null
            : accumulated + after - before;
        if (value !== null && (!Number.isSafeInteger(value) || value < 0)) return undefined;
        if (key === "subtotal") next.subtotal = value ?? amount.subtotal;
        else next[key] = value;
      }
      amount = next;
      measured = state.measured || existing !== undefined || next.subtotal > state.amount.subtotal;
    }
  }
  return {
    nativeThreadId: observation.nativeThreadId,
    turnId,
    total: observation.total,
    amount: { ...amount, basis: "codex-cumulative-delta", completeness: "partial" },
    measured,
  };
}

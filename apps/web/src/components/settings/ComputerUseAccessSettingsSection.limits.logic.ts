/**
 * Exact-millisecond limit editing (plan M5 "Fix UI rounding so a valid
 * sub-minute timeout is not silently rewritten"). Limits are edited in
 * minutes but stored in milliseconds; the draft is converted only when the
 * human changed it, and always clamped in milliseconds so a sub-minute bound
 * (the 10 s action-timeout minimum) can never round to an invalid 0.
 */
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1_000;

/** Minutes for display; whole minutes stay integers, others keep 3 decimals. */
export function formatLimitMinutes(valueMs: number): string {
  if (valueMs % MS_PER_MINUTE === 0) return String(valueMs / MS_PER_MINUTE);
  return String(Number((valueMs / MS_PER_MINUTE).toFixed(3)));
}

/** Human bound text: "10 seconds", "1 minute", "60 minutes". */
export function formatLimitBound(valueMs: number): string {
  if (valueMs % MS_PER_MINUTE !== 0) {
    const seconds = Math.round(valueMs / MS_PER_SECOND);
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  const minutes = valueMs / MS_PER_MINUTE;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export type LimitCommit =
  | { readonly kind: "unchanged" }
  | { readonly kind: "invalid" }
  | { readonly kind: "commit"; readonly valueMs: number };

export function resolveLimitCommit(input: {
  readonly draft: string;
  readonly valueMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}): LimitCommit {
  const draft = input.draft.trim();
  // An untouched draft never rewrites the stored exact value.
  if (draft === formatLimitMinutes(input.valueMs)) return { kind: "unchanged" };
  const minutes = draft === "" ? Number.NaN : Number(draft);
  if (!Number.isFinite(minutes)) return { kind: "invalid" };
  const valueMs = Math.min(input.maxMs, Math.max(input.minMs, Math.round(minutes * MS_PER_MINUTE)));
  return valueMs === input.valueMs ? { kind: "unchanged" } : { kind: "commit", valueMs };
}

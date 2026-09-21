import { Duration } from "effect";

export interface SubscriptionRetryContext {
  readonly error: unknown;
  readonly attempt: number;
}

export type SubscriptionRetryDelay =
  | Duration.Input
  | ((context: SubscriptionRetryContext) => Duration.Input);

export function resolveSubscriptionRetryDelayMs(
  policy: SubscriptionRetryDelay | undefined,
  context: SubscriptionRetryContext,
  fallback: Duration.Input,
): number {
  const input = typeof policy === "function" ? policy(context) : (policy ?? fallback);
  return Duration.toMillis(Duration.fromInputUnsafe(input));
}

export function cappedExponentialRetryDelay(input: {
  readonly attempt: number;
  readonly baseMs: number;
  readonly maxMs: number;
}): number {
  const attempt = Math.max(1, Math.floor(input.attempt));
  return Math.min(input.maxMs, input.baseMs * 2 ** (attempt - 1));
}

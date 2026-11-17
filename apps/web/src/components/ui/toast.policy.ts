/**
 * Shared toast lifetime policy. Every toast is closable and closes on its own;
 * call sites only describe content and severity.
 *
 * Durations are keyed by severity (`TOAST_DURATION_MS`). An explicit duration
 * (`timeout` or `data.dismissAfterVisibleMs`) is kept only when it is at least
 * the severity's duration; shorter ones are raised to it.
 *
 * - Timed toasts use Base UI's store timer, which pauses while the stack is
 *   hovered or focused and while the window is unfocused.
 * - Toasts that asked to persist (`timeout: 0`, Infinity, negative, NaN) and
 *   `loading` toasts (Base UI never times them out) instead count *visible* time,
 *   so thread-scoped toasts hidden behind another thread are not expired unseen.
 *   That countdown also pauses while the stack is hovered or focused.
 * - A `loading` toast that never settles closes after the loading cap; once it
 *   is updated into a final state, that state's duration applies afresh.
 * - A toast tagged with `data.conditionKey` describes an ongoing condition. Once
 *   it is dismissed (close button, swipe, dismiss-all, or auto-dismiss), the same
 *   condition stays quiet for `TOAST_CONDITION_COOLDOWN_MS` unless its severity
 *   escalates (for example warning -> error).
 */
export const TOAST_DURATION_MS = {
  error: 15_000,
  warning: 15_000,
  info: 10_000,
  success: 5_000,
  /** Cap for a progress toast that never settles into a final state. */
  loading: 15_000,
} as const;
/** Info and any other neutral/unknown type. */
export const TOAST_NEUTRAL_DURATION_MS = TOAST_DURATION_MS.info;
export const TOAST_CONDITION_COOLDOWN_MS = 5 * 60_000;

export function toastSeverityDurationMs(type: string | undefined): number {
  return type !== undefined && Object.hasOwn(TOAST_DURATION_MS, type)
    ? TOAST_DURATION_MS[type as keyof typeof TOAST_DURATION_MS]
    : TOAST_NEUTRAL_DURATION_MS;
}

export function isPersistentToastTimeout(timeout: number | undefined): boolean {
  return timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0);
}

/** Base UI store timeout; `0` hands the toast to the visible-time countdown. */
export function resolveToastStoreTimeout(
  type: string | undefined,
  timeout: number | undefined,
): number {
  if (isPersistentToastTimeout(timeout)) return 0;
  return Math.max(timeout ?? 0, toastSeverityDurationMs(type));
}

export function resolveVisibleAutoDismissMs(toast: {
  type?: string | undefined;
  timeout?: number | undefined;
  data?: { dismissAfterVisibleMs?: number | undefined } | undefined;
}): number | undefined {
  const severityMs = toastSeverityDurationMs(toast.type);
  const explicit = toast.data?.dismissAfterVisibleMs;
  if (explicit !== undefined && explicit > 0) return Math.max(explicit, severityMs);
  return toast.type === "loading" || isPersistentToastTimeout(toast.timeout)
    ? severityMs
    : undefined;
}

const SEVERITY_RANK: Readonly<Record<string, number>> = {
  success: 0,
  info: 1,
  loading: 1,
  warning: 2,
  error: 3,
};

export function toastSeverityRank(type: string | undefined): number {
  return type === undefined ? 1 : (SEVERITY_RANK[type] ?? 1);
}

export interface ConditionDismissal {
  readonly dismissedAt: number;
  readonly severityRank: number;
}

export function isConditionSuppressed(
  dismissal: ConditionDismissal | undefined,
  type: string | undefined,
  nowMs: number,
): boolean {
  if (!dismissal) return false;
  if (nowMs - dismissal.dismissedAt >= TOAST_CONDITION_COOLDOWN_MS) return false;
  return toastSeverityRank(type) <= dismissal.severityRank;
}

/**
 * A progress toast the user or auto-dismiss closed still owes its outcome: an
 * update that settles it shows it again, even during a condition cool-down.
 * Progress is a `loading` toast or a persistent one (`timeout: 0`); it settles
 * when it turns into a non-loading result, or into a timed non-loading toast.
 */
export function isProgressOutcome(
  previous: { type?: string | undefined; timeout?: number | undefined },
  next: { type?: string | undefined; timeout?: number | undefined },
): boolean {
  if (next.type === undefined || next.type === "loading") return false;
  if (previous.type === "loading") return true;
  return isPersistentToastTimeout(previous.timeout) && !isPersistentToastTimeout(next.timeout);
}

import * as Cause from "effect/Cause";

/**
 * Fixed, non-secret failure reasons for owner status. They name the step that failed, never a
 * value: no path, token, credential or server prose reaches status through them.
 */
export const MOBILE_ACTIVATION_REASONS = [
  "authority-unavailable",
  "journal-unreadable",
  "publication-failed",
  "selection-failed",
  "consent-revoked",
  "stop-requested",
  "admission-refused",
  "route-unverified",
  "native-cleanup-uncertain",
  "gateway-session-failed",
  "native-epoch-ended-unproven",
  "successor-conflict",
  "successor-restore-refused",
  "successor-channel-unavailable",
  "successor-unready",
  "successor-consent-unknown",
  "successor-legacy-native",
  "successor-native-unsettled",
  "successor-upstream-unavailable",
  "successor-upstream-unreleased",
  "successor-exit-unrecorded",
  "unknown",
] as const;
export type MobileActivationReason = (typeof MOBILE_ACTIVATION_REASONS)[number];

/** Error names that identify a step by themselves, most specific first. */
const NAMED_REASONS: ReadonlyArray<readonly [string, MobileActivationReason]> = [
  ["MobileGatewayAdmissionRevoked", "consent-revoked"],
  ["MobileGatewayNativeAdmissionRefused", "admission-refused"],
  ["MobileGatewayRouteUnverified", "route-unverified"],
  ["MobileActivationWorkerRepair", "native-cleanup-uncertain"],
  ["MobileGatewaySelectionError", "selection-failed"],
  ["MobileActivationAuthorityError", "authority-unavailable"],
];
const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_DEPTH = 8;

function nameOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const tag = (value as { readonly _tag?: unknown })._tag;
  const name = typeof tag === "string" ? tag : (value as { readonly name?: unknown }).name;
  return typeof name === "string" && NAME.test(name) ? name : null;
}

/** Error names along the cause chain (Effect causes squashed, aggregates by first error). */
export function mobileFailureNames(cause: unknown): ReadonlyArray<string> {
  const names: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < MAX_DEPTH && current !== undefined && current !== null; depth++) {
    if (Cause.isCause(current)) current = Cause.squash(current);
    const name = nameOf(current);
    if (name) names.push(name);
    if (current instanceof AggregateError && current.errors.length > 0) {
      current = current.errors[0];
      continue;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return names;
}

/** The step a cause chain names, or `unknown`. Explicit reasons at the failure site win. */
export function classifyMobileActivationCause(cause: unknown): MobileActivationReason {
  const names = mobileFailureNames(cause);
  for (const [name, reason] of NAMED_REASONS) if (names.includes(name)) return reason;
  return "unknown";
}

/** The innermost specific error name (never a message), for diagnosis next to the reason. */
export function mobileFailureDetail(cause: unknown): string | null {
  const names = mobileFailureNames(cause).filter(
    (name) => name !== "Error" && name !== "AggregateError",
  );
  return names.at(-1) ?? null;
}

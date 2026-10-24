import { logV2SettlementDiagnostic } from "./Runtime.settlement.log.ts";

/** Only bigbud-authored guard/deadline text is safe to log; native SDK text may carry request data. */
const BIGBUD_AUTHORED = /^(?:V2 |OpenCode v2 )/;

export type V2RequestFailureKind = "cancelled" | "timeout" | "guard" | "native";

/** Which fence was already aborted when the request failed. */
export interface V2RequestAbortState {
  readonly consentAborted: boolean;
  readonly operationAborted: boolean;
  readonly callerAborted: boolean;
}

/** Classifies failures that `v2Request` otherwise collapses into one generic message. */
export function classifyV2RequestFailure(
  operation: string,
  error: unknown,
): { readonly kind: V2RequestFailureKind; readonly reason?: string; readonly errorName: string } {
  // Error.name is native-assignable; only a short identifier may reach user-facing text.
  const rawName = error instanceof Error ? error.name : typeof error;
  const errorName = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(rawName) ? rawName : "Error";
  const message = error instanceof Error ? error.message : undefined;
  if (message === `${operation} cancelled.` || errorName === "AbortError")
    return { kind: "cancelled", errorName };
  if (message?.startsWith(`${operation} timed out after `))
    return { kind: "timeout", reason: message.slice(operation.length + 1), errorName };
  if (message !== undefined && BIGBUD_AUTHORED.test(message))
    return { kind: "guard", reason: message.slice(0, 200), errorName };
  // The SDK wraps guarded-fetch rejections as ClientError("Transport", { cause }).
  const guard = bigbudAuthoredCause(error);
  if (guard) return { kind: "guard", reason: guard.slice(0, 200), errorName };
  const sdkReason = (error as { reason?: unknown } | undefined)?.reason;
  return typeof sdkReason === "string" && /^[A-Za-z]{1,40}$/.test(sdkReason)
    ? { kind: "native", reason: `${errorName}/${sdkReason}`, errorName }
    : { kind: "native", errorName };
}

function bigbudAuthoredCause(error: unknown): string | undefined {
  let current = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (BIGBUD_AUTHORED.test(current.message)) return current.message;
    current = current.cause;
  }
  return undefined;
}

/** Same generic message as before, plus the redacted classification for callers and traces. */
export class V2RequestFailedError extends Error {
  readonly kind: V2RequestFailureKind;
  readonly reason: string | undefined;
  constructor(operation: string, error: unknown) {
    super(`OpenCode v2 ${operation} failed or timed out; admission may be unconfirmed.`);
    const classified = classifyV2RequestFailure(operation, error);
    this.name = "V2RequestFailedError";
    this.kind = classified.kind;
    this.reason =
      classified.reason ?? (classified.kind === "native" ? classified.errorName : undefined);
  }
}

/** Safe suffix for user-facing failure details: bigbud-authored text or a failure kind only. */
export function v2SafeFailureSuffix(error: unknown): string {
  if (error instanceof V2RequestFailedError)
    return ` (${error.kind}${error.reason ? `: ${error.reason}` : ""})`;
  if (error instanceof Error && BIGBUD_AUTHORED.test(error.message))
    return ` (${error.message.slice(0, 200)})`;
  return "";
}

/** Redacted: operation, failure kind, bigbud-authored reason, error class and fence state only.
 * A cancellation requested only by the caller itself is routine and is not logged. */
export function logV2RequestFailure(
  operation: string,
  error: unknown,
  aborts: V2RequestAbortState,
) {
  const { kind, reason, errorName } = classifyV2RequestFailure(operation, error);
  if (
    kind === "cancelled" &&
    aborts.callerAborted &&
    !aborts.consentAborted &&
    !aborts.operationAborted
  )
    return;
  logV2SettlementDiagnostic("OpenCode v2 request failed", {
    operation,
    kind,
    errorName,
    ...aborts,
    ...(reason ? { reason } : {}),
  });
}

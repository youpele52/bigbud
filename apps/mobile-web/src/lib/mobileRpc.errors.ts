import * as Cause from "effect/Cause";
import { MOBILE_RECOVERY_WS_METHODS } from "@bigbud/contracts/server/mobile.recovery";

type RecoveryMethod = (typeof MOBILE_RECOVERY_WS_METHODS)[keyof typeof MOBILE_RECOVERY_WS_METHODS];

export class MobileRecoveryUnsupportedError extends Error {
  override readonly name = "MobileRecoveryUnsupportedError";
  constructor(
    readonly method: RecoveryMethod,
    cause?: unknown,
  ) {
    super(`Recovery method unavailable: ${method}`, { cause });
  }
}

/** Only the actual Effect RPC unknown-tag defect for this request proves old-server support. */
export function normalizeRecoveryRpcError(error: unknown, method: RecoveryMethod): unknown {
  if (Cause.isCause(error) && error.reasons.length === 1) {
    const reason = error.reasons[0]!;
    if (Cause.isDieReason(reason) && reason.defect === `Unknown request tag: ${method}`) {
      return new MobileRecoveryUnsupportedError(method, error);
    }
  }
  return error;
}

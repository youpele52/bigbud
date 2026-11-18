import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import {
  markMobileCommandUncertain,
  settleMobileCommandRejected,
  type MobileCommandDeliveryState,
} from "./mobileCommandDelivery.logic";

/** Only a typed authorization response proves rejection; transport failures do not. */
export function isMobilePermissionDenied(error: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (Schema.is(OrchestrationDispatchCommandError)(error)) return error.code === "unauthorized";
  if (Cause.isCause(error) && error.reasons.length === 1) {
    const reason = error.reasons[0]!;
    return Cause.isFailReason(reason) && isMobilePermissionDenied(reason.error, depth + 1);
  }
  return error instanceof Error && isMobilePermissionDenied(error.cause, depth + 1);
}

export function settleMobileDispatchFailure(state: MobileCommandDeliveryState, error: unknown) {
  return isMobilePermissionDenied(error)
    ? settleMobileCommandRejected(state)
    : markMobileCommandUncertain(state);
}

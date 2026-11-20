import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { MobileGatewayProcessError } from "./mobileGatewayProcess.lifetime.ts";

/** Process helper settles cleanup before its exit; preserve every uncertain/unknown cause. */
export function mobileGatewayOwnerCleanupConfirmed(exit: Exit.Exit<unknown, unknown>): boolean {
  return (
    Exit.isSuccess(exit) ||
    exit.cause.reasons.every(
      (reason) =>
        Cause.isInterruptReason(reason) ||
        (Cause.isFailReason(reason) &&
          reason.error instanceof MobileGatewayProcessError &&
          !reason.error.repairRequired),
    )
  );
}

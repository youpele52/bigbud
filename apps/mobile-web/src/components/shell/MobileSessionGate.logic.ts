import type { MobileConnectionState } from "../../logic/mobileConnection.logic";
import type { MobileRecoveryState } from "../../logic/mobileRecovery.types";

export function isMobileStartupWaiting(
  connection: MobileConnectionState,
  recovery: MobileRecoveryState,
  snapshotPending: boolean,
): boolean {
  if (connection.authorization !== "unknown" || connection.transport === "exhausted") return false;
  if (connection.transport === "connecting" || connection.transport === "retrying") return true;
  return (
    recovery.freshness === "refreshing" ||
    (recovery.freshness === "unavailable" && recovery.reason === null && snapshotPending)
  );
}

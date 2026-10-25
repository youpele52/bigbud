import type { OwnershipRecoveryState } from "@bigbud/contracts/server/ipc.ownershipRecovery.ts";

export function isOwnershipRecoveryState(value: unknown): value is OwnershipRecoveryState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.phase === "string" &&
    ["available", "checking", "stopping", "retrying", "failed", "yielded"].includes(state.phase) &&
    (state.error === undefined ||
      (typeof state.error === "string" &&
        [
          "owner_unverified",
          "owner_changed",
          "unsupported_platform",
          "supervisor_unavailable",
          "shutdown_timed_out",
          "stale_generation",
          "application_quitting",
          "retry_start_failed",
        ].includes(state.error)))
  );
}

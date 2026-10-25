export type OwnershipRecoveryPhase =
  | "available"
  | "checking"
  | "stopping"
  | "retrying"
  | "failed"
  | "yielded";
export type OwnershipRecoveryError =
  | "owner_unverified"
  | "owner_changed"
  | "unsupported_platform"
  | "supervisor_unavailable"
  | "shutdown_timed_out"
  | "stale_generation"
  | "application_quitting"
  | "retry_start_failed";
export interface OwnershipRecoveryState {
  readonly phase: OwnershipRecoveryPhase;
  readonly error?: OwnershipRecoveryError;
}

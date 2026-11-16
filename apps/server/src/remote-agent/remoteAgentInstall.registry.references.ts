import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";

/**
 * Update phases that may still read or start these bytes. `ready-for-reconnect` is a completed
 * install record; it stays on older builds after a newer one becomes current, so it is not a use.
 */
const IN_FLIGHT_UPDATE_PHASES: ReadonlySet<string> = new Set([
  "waiting-for-capacity",
  "reserved",
  "installing",
  "checking",
  "uncertain",
]);

export interface RemoteAgentBuildReferenceOptions {
  /** Ignore acknowledged publication history (published, not pending) that retirement consumes. */
  readonly ignoreAcknowledgedStages?: boolean;
  /** Accept a `ready` launch for the idle-shutdown path; uncertain launches always count. */
  readonly allowReadyLaunch?: boolean;
  /**
   * The retirement's own reservation ID: predecessor withdrawal records an update under it as
   * durable evidence of the retirement, which is not a competing use of the bytes.
   */
  readonly retirementId?: string;
}

/**
 * The one set of durable references that protects a build from retirement. Reservation, the
 * post-shutdown safety check and the tombstone write all use it, so they cannot drift apart.
 * Tombstone reconciliation applies this plus predecessor and competing-retirement checks.
 */
export function remoteAgentBuildIsReferenced(
  state: RemoteAgentRegistry,
  buildId: string,
  options: RemoteAgentBuildReferenceOptions = {},
): boolean {
  return (
    state.current === buildId ||
    state.pending === buildId ||
    state.pins.some((pin) => pin.buildId === buildId) ||
    state.stages.some(
      (stage) =>
        stage.buildId === buildId &&
        stage.phase !== "cancelled" &&
        !(options.ignoreAcknowledgedStages === true && stage.phase === "published"),
    ) ||
    state.launches.some(
      (launch) =>
        launch.buildId === buildId &&
        launch.phase !== "proven-dead" &&
        !(options.allowReadyLaunch === true && launch.phase === "ready"),
    ) ||
    state.admissions.some((admission) => admission.buildId === buildId) ||
    state.restartReservations.some(
      (reservation) =>
        reservation.buildId === buildId &&
        reservation.phase !== "failed" &&
        reservation.phase !== "ready",
    ) ||
    state.updates.some(
      (update) =>
        update.buildId === buildId &&
        update.requestId !== options.retirementId &&
        IN_FLIGHT_UPDATE_PHASES.has(update.phase),
    )
  );
}

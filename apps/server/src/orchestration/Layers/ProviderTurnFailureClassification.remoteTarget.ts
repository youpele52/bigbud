/**
 * Remote-target turn-start failures: the SSH target was unavailable (credential needed, user
 * Disconnect, unreachable host), so the provider session itself is not at fault. They are never
 * classified `session-dead`, which keeps them out of in-place recovery and automatic forks.
 *
 * @module ProviderTurnFailureClassification.remoteTarget
 */
import type {
  TurnStartFailureClass,
  TurnStartRemoteTargetFailure,
} from "@bigbud/contracts/orchestration/orchestration.turnFailure.ts";
import { Cause } from "effect";

import { describeRemoteTargetUnavailable } from "../../ssh/sshTargetUnavailable.ts";

/** The `remoteTarget` marker for a turn-start failure (a `Cause` or an error value), if any. */
export function describeRemoteTargetTurnStartFailure(
  failure: unknown,
): TurnStartRemoteTargetFailure | undefined {
  return describeRemoteTargetUnavailable(Cause.isCause(failure) ? Cause.squash(failure) : failure);
}

/** `auth-or-quota` when the user must supply a credential; `unknown` for disconnected/unreachable. */
export function remoteTargetFailureClass(
  remoteTarget: TurnStartRemoteTargetFailure,
): TurnStartFailureClass {
  return remoteTarget.reason === "auth-required" ? "auth-or-quota" : "unknown";
}

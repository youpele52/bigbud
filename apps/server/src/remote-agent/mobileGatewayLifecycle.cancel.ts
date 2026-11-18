import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { mobileRegistryOwnerEqual } from "./remoteAgentInstall.mobile.schema.ts";
import {
  mobileGatewayBuildPin,
  type MobileGatewayAdmissionContext,
} from "./mobileGatewayLifecycle.transitions.ts";
import type { MobileGatewayAttempt } from "./mobileGatewayLifecycle.schema.ts";

/** Original private uninvoked permit only; never successor reconstruction from a nonce/PID. */
export function cancelUnlaunchedMobileGatewayAttempt(
  state: RemoteAgentRegistry,
  context: MobileGatewayAdmissionContext,
  nonce: string,
): RemoteAgentRegistry {
  if (state.schemaVersion !== 3 || !mobileRegistryOwnerEqual(state.mobile.owner, context.owner))
    throw new Error("Original gateway installation required for no-launch cancellation.");
  const lifecycle = state.mobile.gatewayLifecycle;
  const attempt = lifecycle?.attempts.find((a) => a.nonce === nonce);
  if (!attempt) {
    if (state.pins.some((p) => p.owner === mobileGatewayBuildPin(nonce)))
      throw new Error("Unresolved gateway pin has no matching original reservation.");
    return state;
  }
  if (
    !lifecycle ||
    JSON.stringify([
      attempt.controller,
      attempt.controllerHost,
      attempt.stageId,
      attempt.releaseId,
      attempt.consentRevision,
      attempt.binding,
      attempt.configuration,
    ]) !==
      JSON.stringify([
        context.controller,
        context.controllerHost,
        context.stageId,
        context.releaseId,
        context.consentRevision,
        context.binding,
        context.configuration,
      ])
  )
    throw new Error("Original unlaunched gateway permit tuple required.");
  if (
    attempt.phase === "exit-confirmed" &&
    attempt.completionEvidence?.kind === "original-permit-not-launched"
  )
    return state;
  if (
    attempt.nativeOwnership ||
    !["reserved", "attempted"].includes(attempt.phase) ||
    attempt.child ||
    state.pins.find((p) => p.owner === mobileGatewayBuildPin(nonce))?.buildId !==
      attempt.binding.buildId
  )
    throw new Error("Gateway callback may have run; no-launch cancellation refused.");
  if (!Number.isSafeInteger(context.now) || context.now < 0)
    throw new Error("Invalid no-launch clock.");
  const now = Math.max(lifecycle.lastObservedUnixMs, context.now);
  const cancelled: MobileGatewayAttempt = {
    ...attempt,
    phase: "exit-confirmed",
    exitedAtUnixMs: now,
    completionEvidence: { kind: "original-permit-not-launched" },
  };
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...state,
      revision: state.revision + 1,
      pins: state.pins.filter(
        (p) => !(p.owner === mobileGatewayBuildPin(nonce) && p.buildId === attempt.binding.buildId),
      ),
      mobile: {
        ...state.mobile,
        gatewayLifecycle: {
          ...lifecycle,
          lastObservedUnixMs: now,
          repairRequired: lifecycle.repairRequired || context.now < lifecycle.lastObservedUnixMs,
          attempts: lifecycle.attempts.map((a) => (a.nonce === nonce ? cancelled : a)),
        },
      },
    }),
  );
}

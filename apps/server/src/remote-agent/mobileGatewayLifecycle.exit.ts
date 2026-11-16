import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { mobileRegistryOwnerEqual } from "./remoteAgentInstall.mobile.schema.ts";
import type {
  MobileGatewayAttempt,
  MobileGatewayCompletionEvidence,
} from "./mobileGatewayLifecycle.schema.ts";
import {
  mobileGatewayBuildPin,
  type MobileGatewayAdmissionContext,
} from "./mobileGatewayLifecycle.transitions.ts";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Data transition behind the original child handle/event capability; never grants launch authority. */
export function completeObservedMobileGatewayExit(
  state: RemoteAgentRegistry,
  context: MobileGatewayAdmissionContext,
  nonce: string,
  child: MobileGatewayAttempt["child"],
  evidence: MobileGatewayCompletionEvidence,
): RemoteAgentRegistry {
  if (state.schemaVersion !== 3 || !mobileRegistryOwnerEqual(state.mobile.owner, context.owner))
    throw new Error("Original gateway installation authority required for exit completion.");
  const lifecycle = state.mobile.gatewayLifecycle;
  const attempt = lifecycle?.attempts.find((a) => a.nonce === nonce);
  if (
    !lifecycle ||
    !attempt ||
    !equal(
      [
        attempt.controller,
        attempt.controllerHost,
        attempt.stageId,
        attempt.releaseId,
        attempt.consentRevision,
        attempt.binding,
        attempt.configuration,
      ],
      [
        context.controller,
        context.controllerHost,
        context.stageId,
        context.releaseId,
        context.consentRevision,
        context.binding,
        context.configuration,
      ],
    ) ||
    attempt.phase === "reserved" ||
    (attempt.child && !equal(attempt.child, child)) ||
    (evidence.kind === "original-handle-exit" &&
      child !== undefined &&
      evidence.pid !== child.pid) ||
    (evidence.kind === "original-handle-spawn-failed" && child !== undefined)
  )
    throw new Error("Original attempted gateway/controller/child required for exit completion.");
  if (attempt.phase === "exit-confirmed") return state;
  if (
    state.pins.find((p) => p.owner === mobileGatewayBuildPin(nonce))?.buildId !==
    attempt.binding.buildId
  )
    throw new Error("Gateway base pin changed; preserve references for repair.");
  if (!Number.isSafeInteger(context.now) || context.now < 0)
    throw new Error("Invalid exit observation clock.");
  // Preserve monotonic durable observation floor, but never clear a regressed/spent launch budget.
  const now = Math.max(lifecycle.lastObservedUnixMs, context.now);
  const completed: MobileGatewayAttempt = {
    ...attempt,
    phase: "exit-confirmed",
    ...(child ? { child } : {}),
    completionEvidence: evidence,
    exitedAtUnixMs: now,
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
          attempts: lifecycle.attempts.map((a) => (a.nonce === nonce ? completed : a)),
        },
      },
    }),
  );
}

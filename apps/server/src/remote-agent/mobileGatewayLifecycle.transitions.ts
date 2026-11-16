import { assertMobileGatewaySelectedBinding } from "./mobileGatewayLifecycle.binding.state.ts";
import { createHash } from "node:crypto";
import { MOBILE_GATEWAY_POLICY } from "@bigbud/shared/mobileGatewaySupervisor.config";
import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import {
  mobileRegistryOwnerEqual,
  type MobileRegistryOwner,
} from "./remoteAgentInstall.mobile.schema.ts";
import { pinRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";
import {
  MAX_MOBILE_GATEWAY_ATTEMPTS,
  type MobileGatewayAttempt,
  type MobileGatewayLifecycle,
  type MobileGatewayBinding,
  type MobileGatewayConfiguration,
  type MobileGatewayControllerHost,
} from "./mobileGatewayLifecycle.schema.ts";

export interface MobileGatewayAdmissionContext {
  readonly owner: MobileRegistryOwner;
  readonly controller: MobileGatewayAttempt["controller"];
  readonly controllerHost: MobileGatewayControllerHost;
  readonly stageId: string;
  readonly releaseId: string;
  readonly consentRevision: number;
  readonly binding: MobileGatewayBinding;
  readonly configuration: MobileGatewayConfiguration;
  readonly now: number;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function mobileGatewayBuildPin(nonce: string): string {
  return (
    "mobile-gateway:" +
    createHash("sha256").update("bigbud.gateway-base-pin.v1\0").update(nonce).digest("hex")
  );
}
function owned(state: RemoteAgentRegistry, context: MobileGatewayAdmissionContext) {
  if (
    state.schemaVersion !== 3 ||
    !mobileRegistryOwnerEqual(state.mobile.owner, context.owner) ||
    !state.mobile.consent.enabled ||
    state.mobile.consent.revision !== context.consentRevision
  )
    throw new Error("Gateway requires current original owner and separate enabled consent.");
  const stage = state.mobile.stages.find((s) => s.id === context.stageId);
  assertMobileGatewaySelectedBinding(state, context.binding);
  if (
    !stage ||
    stage.phase !== "files-published" ||
    !stage.publicationReceipt ||
    stage.releaseId !== context.releaseId ||
    stage.consentRevision !== context.consentRevision ||
    !Number.isSafeInteger(context.now) ||
    context.now < 0
  )
    throw new Error("Gateway publication or canonical agent binding changed.");
  return state;
}
function write(state: RemoteAgentRegistry, lifecycle: MobileGatewayLifecycle, pins = state.pins) {
  if (state.schemaVersion !== 3) throw new Error("Gateway requires v3 CAS.");
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...state,
      pins,
      revision: state.revision + 1,
      mobile: { ...state.mobile, gatewayLifecycle: lifecycle },
    }),
  );
}
function repair(state: RemoteAgentRegistry, lifecycle: MobileGatewayLifecycle) {
  return lifecycle.repairRequired ? state : write(state, { ...lifecycle, repairRequired: true });
}
export function reserveMobileGatewayAttempt(
  state: RemoteAgentRegistry,
  context: MobileGatewayAdmissionContext,
  nonce: string,
): RemoteAgentRegistry {
  const current = owned(state, context);
  const lifecycle = current.mobile.gatewayLifecycle ?? {
    lastObservedUnixMs: context.now,
    repairRequired: false,
    attempts: [],
  };
  if (context.now < lifecycle.lastObservedUnixMs) return repair(state, lifecycle);
  const prior = lifecycle.attempts.find((a) => a.nonce === nonce);
  if (prior) {
    if (
      !equal(
        [
          prior.stageId,
          prior.releaseId,
          prior.consentRevision,
          prior.controller,
          prior.controllerHost,
          prior.binding,
          prior.configuration,
        ],
        [
          context.stageId,
          context.releaseId,
          context.consentRevision,
          context.controller,
          context.controllerHost,
          context.binding,
          context.configuration,
        ],
      )
    )
      throw new Error("Gateway nonce belongs to another admission.");
    return state; // Durable nonce retries never create fresh launch authority.
  }
  if (lifecycle.repairRequired) return state;
  if (lifecycle.attempts.some((a) => a.phase !== "exit-confirmed"))
    throw new Error("Prior gateway child or launch outcome is uncertain; overlap refused.");
  const recentRestarts = lifecycle.attempts.filter(
    (a) =>
      a.kind === "crash-restart" &&
      context.now - (a.attemptedAtUnixMs ?? a.reservedAtUnixMs) <
        MOBILE_GATEWAY_POLICY.crashWindowMs,
  );
  if (
    lifecycle.attempts.length >= MAX_MOBILE_GATEWAY_ATTEMPTS ||
    recentRestarts.length >= MOBILE_GATEWAY_POLICY.maxCrashRestarts
  )
    return repair(state, lifecycle);
  const attempt: MobileGatewayAttempt = {
    nonce,
    stageId: context.stageId,
    releaseId: context.releaseId,
    consentRevision: context.consentRevision,
    controller: context.controller,
    controllerHost: context.controllerHost,
    binding: context.binding,
    configuration: context.configuration,
    reservedAtUnixMs: context.now,
    kind: lifecycle.attempts.length ? "crash-restart" : "initial",
    phase: "reserved",
  };
  const pinned = pinRemoteAgentBuild(state, mobileGatewayBuildPin(nonce), context.binding.buildId);
  return write(
    state,
    {
      lastObservedUnixMs: context.now,
      repairRequired: false,
      attempts: [...lifecycle.attempts, attempt],
    },
    pinned.pins,
  );
}
export function advanceMobileGatewayAttempt(
  state: RemoteAgentRegistry,
  context: MobileGatewayAdmissionContext,
  nonce: string,
  phase: "attempted" | "child-owned" | "exit-confirmed",
  child?: MobileGatewayAttempt["child"],
): RemoteAgentRegistry {
  const current = owned(state, context),
    lifecycle = current.mobile.gatewayLifecycle;
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
    )
  )
    throw new Error("Original gateway attempt owner required.");
  if (context.now < lifecycle.lastObservedUnixMs) return repair(state, lifecycle);
  if (lifecycle.repairRequired) throw new Error("Gateway requires explicit owner repair.");
  if (attempt.phase === phase && equal(attempt.child, child)) return state;
  if (attempt.nativeOwnership && phase !== "attempted")
    throw Error("Independent native child completion requires original native terminal proof.");
  const previous = {
    attempted: "reserved",
    "child-owned": "attempted",
    "exit-confirmed": "child-owned",
  }[phase];
  if (
    attempt.phase !== previous ||
    (phase !== "attempted" && !child) ||
    (phase === "exit-confirmed" && !equal(attempt.child, child))
  )
    throw new Error("Gateway child ownership or phase mismatch.");
  const next: MobileGatewayAttempt = {
    ...attempt,
    phase,
    ...(phase === "attempted" ? { attemptedAtUnixMs: context.now } : {}),
    ...(child ? { child } : {}),
    ...(phase === "exit-confirmed" ? { exitedAtUnixMs: context.now } : {}),
  };
  return write(
    state,
    {
      ...lifecycle,
      lastObservedUnixMs: context.now,
      attempts: lifecycle.attempts.map((a) => (a.nonce === nonce ? next : a)),
    },
    phase === "exit-confirmed"
      ? state.pins.filter((p) => p.owner !== mobileGatewayBuildPin(nonce))
      : state.pins,
  );
}

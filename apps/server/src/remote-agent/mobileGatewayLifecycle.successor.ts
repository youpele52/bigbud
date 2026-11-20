import { compareProcessStartToken } from "@bigbud/shared/processStartToken";
import type { VerifiedMobilePublication } from "./mobileOptionalPublication.ts";
import { withMobilePublicationTeardown } from "./mobileGatewayLifecycle.publication.ts";
import { mobileRegistryOwnerEqual } from "./remoteAgentInstall.mobile.schema.ts";
import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { mobileGatewayBuildPin } from "./mobileGatewayLifecycle.transitions.ts";
import type {
  MobileGatewayAttempt,
  MobileGatewayCompletionEvidence,
} from "./mobileGatewayLifecycle.schema.ts";

function complete(
  state: RemoteAgentRegistry,
  snapshot: MobileGatewayAttempt,
  evidence: MobileGatewayCompletionEvidence,
  now: number,
): RemoteAgentRegistry {
  if (state.schemaVersion !== 3) throw new Error("Gateway successor requires original v3 journal.");
  const lifecycle = state.mobile.gatewayLifecycle;
  const current = lifecycle?.attempts.find((a) => a.nonce === snapshot.nonce);
  if (!lifecycle || !current || JSON.stringify(current) !== JSON.stringify(snapshot))
    throw new Error("Recorded gateway attempt changed during kernel reconciliation.");
  if (
    state.pins.find((p) => p.owner === mobileGatewayBuildPin(snapshot.nonce))?.buildId !==
    snapshot.binding.buildId
  )
    throw new Error("Recorded gateway base pin changed; preserve references for repair.");
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid successor observation clock.");
  const floor = Math.max(lifecycle.lastObservedUnixMs, now);
  const terminal: MobileGatewayAttempt = {
    ...current,
    phase: "exit-confirmed",
    completionEvidence: evidence,
    exitedAtUnixMs: floor,
  };
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...state,
      revision: state.revision + 1,
      pins: state.pins.filter(
        (p) =>
          !(
            p.owner === mobileGatewayBuildPin(snapshot.nonce) &&
            p.buildId === snapshot.binding.buildId
          ),
      ),
      mobile: {
        ...state.mobile,
        gatewayLifecycle: {
          ...lifecycle,
          lastObservedUnixMs: floor,
          repairRequired: lifecycle.repairRequired || now < lifecycle.lastObservedUnixMs,
          attempts: lifecycle.attempts.map((a) => (a.nonce === snapshot.nonce ? terminal : a)),
        },
      },
    }),
  );
}

/** Reconcile only recorded child identity after proven old-controller death; never adopts an attempt. */
export function reconcileRecordedMobileGatewayExit(
  proof: VerifiedMobilePublication,
  nonce: string,
) {
  return withMobilePublicationTeardown(proof, async (authority, signal) => {
    const store = authority.registry(signal),
      state = await store.read();
    if (state.schemaVersion !== 3 || !mobileRegistryOwnerEqual(state.mobile.owner, authority.pin))
      throw new Error("Gateway successor requires the original authority and installation.");
    const attempt = state.mobile.gatewayLifecycle?.attempts.find((a) => a.nonce === nonce);
    if (!attempt) throw new Error("Recorded gateway attempt is unavailable.");
    if (attempt.phase === "exit-confirmed") return { nonce, status: "already-exited" as const };
    if (attempt.phase !== "child-owned" || !attempt.child || !attempt.controllerHost)
      throw new Error("Unrecorded gateway child/host requires explicit owner repair.");
    if (
      attempt.controller.id === authority.controller.id ||
      compareProcessStartToken(attempt.controller.startedAt, attempt.controller.startedAt) !==
        "same" ||
      compareProcessStartToken(attempt.child.startedAt, attempt.child.startedAt) !== "same"
    )
      throw new Error("Previous gateway controller/child identity is live or unprovable.");
    const host = attempt.controllerHost;
    const classify = (process: { readonly pid: number; readonly startedAt: string }) =>
      authority.owner.classifyOwner({
        ...process,
        hostname: host.hostname,
        machineId: host.machineId,
      });
    if (classify(attempt.controller) !== "dead")
      throw new Error("Previous gateway controller is live, foreign or unprovable.");
    if (classify(attempt.child) !== "dead")
      throw new Error("Recorded gateway child is live, foreign or unprovable.");
    await authority.assertAuthority();
    const evidence: MobileGatewayCompletionEvidence = {
      kind: "successor-recorded-child-dead",
      reconciledBy: authority.controller,
      reconcilerHost: {
        hostname: authority.owner.hostname,
        machineId: authority.owner.machineId,
      },
    };
    await store.update((current) => {
      if (
        current.schemaVersion !== 3 ||
        !mobileRegistryOwnerEqual(current.mobile.owner, authority.pin)
      )
        throw new Error("Gateway successor installation changed before completion.");
      return complete(current, attempt, evidence, Date.now());
    });
    return { nonce, status: "recorded-dead-exit" as const };
  });
}

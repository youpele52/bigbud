import { PROCESS_START_TOKEN_PREFIX } from "@bigbud/shared/processStartToken";
import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import {
  mobileRegistryOwnerEqual,
  type MobileRegistryOwner,
} from "./remoteAgentInstall.mobile.schema.ts";
import {
  reserveMobileGatewayAttempt,
  mobileGatewayBuildPin,
  type MobileGatewayAdmissionContext,
} from "./mobileGatewayLifecycle.transitions.ts";
import type { MobileGatewayAttempt } from "./mobileGatewayLifecycle.schema.ts";
import type {
  MobileNativeGatewayOwnership,
  MobileNativeGatewayCompletion,
} from "./mobileGatewayLifecycle.native.schema.ts";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Data transition only. Original publication/client/receipt admission is mandatory at its caller. */
export function reserveNativeMobileGatewayAttempt(
  state: RemoteAgentRegistry,
  context: MobileGatewayAdmissionContext,
  original: MobileNativeGatewayOwnership,
): RemoteAgentRegistry {
  if (state.schemaVersion !== 3) throw Error("Native gateway requires existing mobile CAS.");
  const binding = original.binding,
    release = state.mobile.releases.find((r) => r.id === context.releaseId);
  if (
    !release ||
    binding.authority !== context.owner.authority.authorityId ||
    binding.installation !== context.owner.installationFingerprint ||
    binding.nativeEpoch !== context.binding.epoch ||
    binding.publicationSha256 !== context.releaseId.slice("mobile-release:".length) ||
    binding.executableSha256 !== release.gateway.sha256 ||
    binding.assetsSha256 !== release.assets.sha256
  )
    throw Error("Native original binding differs from verified publication/current base epoch.");
  const prior = state.mobile.gatewayLifecycle?.attempts.find((a) => a.nonce === binding.nonce);
  if (prior && !equal(prior.nativeOwnership, original))
    throw Error("Native nonce belongs to a different original execution receipt.");
  const reserved = reserveMobileGatewayAttempt(state, context, binding.nonce);
  if (reserved.schemaVersion !== 3 || reserved.mobile.gatewayLifecycle?.repairRequired || prior)
    return reserved;
  const lifecycle = reserved.mobile.gatewayLifecycle;
  if (!lifecycle) throw Error("Native original reservation unavailable.");
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...reserved,
      mobile: {
        ...reserved.mobile,
        gatewayLifecycle: {
          ...lifecycle,
          attempts: lifecycle.attempts.map((a) =>
            a.nonce === binding.nonce ? Object.assign({}, a, { nativeOwnership: original }) : a,
          ),
        },
      },
    }),
  );
}

/** Teardown tolerates revoked consent/rotated P4, but never changes original execution identity. */
export function completeNativeMobileGatewayAttempt(
  state: RemoteAgentRegistry,
  owner: MobileRegistryOwner,
  original: MobileNativeGatewayOwnership,
  completion: MobileNativeGatewayCompletion,
  now: number,
): RemoteAgentRegistry {
  if (state.schemaVersion !== 3 || !mobileRegistryOwnerEqual(state.mobile.owner, owner))
    throw Error("Current held authority/installation must match original native CAS.");
  const lifecycle = state.mobile.gatewayLifecycle;
  const attempt = lifecycle?.attempts.find((a) => a.nonce === original.binding.nonce);
  if (!lifecycle || !attempt || !equal(attempt.nativeOwnership, original) || attempt.child)
    throw Error("Exact immutable native attempt and original receipt required.");
  if (
    completion.kind === "native-exit" &&
    (completion.originalController.pid !== attempt.controller.pid ||
      `${PROCESS_START_TOKEN_PREFIX}linux:${completion.originalController.boot}:${completion.originalController.started}` !==
        attempt.controller.startedAt)
  )
    throw Error("Native original controller differs from immutable attempted owner.");
  if (attempt.phase === "exit-confirmed") {
    if (state.pins.some((p) => p.owner === mobileGatewayBuildPin(attempt.nonce)))
      throw Error("Native terminal base pin remains; admitted repair required.");
    if (!equal(attempt.completionEvidence, completion))
      throw Error("Native terminal evidence is immutable.");
    return state;
  }
  const pin = mobileGatewayBuildPin(attempt.nonce);
  if (state.pins.find((p) => p.owner === pin)?.buildId !== attempt.binding.buildId)
    throw Error("Native original base pin changed; preserve execution assets.");
  if (!Number.isSafeInteger(now) || now < 0) throw Error("Invalid native completion clock.");
  const observed = Math.max(lifecycle.lastObservedUnixMs, now);
  const terminal: MobileGatewayAttempt = {
    ...attempt,
    phase: "exit-confirmed",
    exitedAtUnixMs: observed,
    completionEvidence: completion,
  };
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...state,
      revision: state.revision + 1,
      pins: state.pins.filter((p) => p.owner !== pin),
      mobile: {
        ...state.mobile,
        gatewayLifecycle: {
          ...lifecycle,
          lastObservedUnixMs: observed,
          repairRequired: lifecycle.repairRequired || now < lifecycle.lastObservedUnixMs,
          attempts: lifecycle.attempts.map((a) => (a.nonce === attempt.nonce ? terminal : a)),
        },
      },
    }),
  );
}

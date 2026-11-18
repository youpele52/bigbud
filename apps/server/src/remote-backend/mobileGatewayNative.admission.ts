import * as Schema from "effect/Schema";
import type { RemoteMobileAdmissionStamp } from "./mobileGatewayStatus.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import { withMobilePublicationOwner } from "../remote-agent/mobileGatewayLifecycle.publication.ts";
import { assertMobilePublicationAuthority } from "../remote-agent/mobileOptionalPublication.authority.ts";
import { MobileNativeGatewayOwnership } from "../remote-agent/mobileGatewayLifecycle.native.schema.ts";
import { mobileRegistryOwnerEqual } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import { mobileGatewayBuildPin } from "../remote-agent/mobileGatewayLifecycle.transitions.ts";
import { remoteAgentBuildId } from "../remote-agent/remoteAgentRuntime.ts";
import {
  assertOriginalNativeServiceLeaseClient,
  type NativeServiceLeaseClient,
  type PendingOriginalNativeLease,
  type VerifiedNativeLease,
} from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import { localSupervisorTarget } from "./localSupervisorIdentity.ts";
import { MobileGatewayAdmissionRevoked } from "./mobileGatewayOwner.read.ts";
import {
  mobileGatewayAdmissionBatch,
  readMobileGatewayAdmissionRegistry,
} from "./mobileGatewayAdmission.batch.ts";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** The journal row does not admit this controller; its name classifies owner status. */
export class MobileGatewayNativeAdmissionRefused extends Error {
  override readonly name = "MobileGatewayNativeAdmissionRefused";
}

/**
 * Native admission stamp for one original lease the native owner holds for this controller.
 *
 * A read admits only while the journal row for this nonce is still the captured `attempted` row
 * with the exact native ownership, consent revision and configuration; durable consent is enabled
 * at that revision; and native status reports the original scope `live` at the captured grant
 * generation. Failed or uncertain reads (including the owner client's own 20 s IO timeout) reject.
 * A changed generation or consent revision rejects with `MobileGatewayAdmissionRevoked`.
 */
export async function mobileGatewayNativeAdmission(input: {
  readonly proof: VerifiedMobilePublication;
  readonly client: NativeServiceLeaseClient;
  readonly pending: PendingOriginalNativeLease;
  readonly lease: VerifiedNativeLease;
  readonly nonce: string;
  readonly port: number;
  readonly externalOrigin: string;
  readonly owners: RemoteAgentOwnerStore;
  readonly signal: AbortSignal;
}) {
  const { client, pending } = input;
  assertOriginalNativeServiceLeaseClient(client);
  // Both tokens must belong to this client, and the grant to exactly this pending intent.
  const original = Schema.decodeUnknownSync(MobileNativeGatewayOwnership)(
    client.original(pending),
    { onExcessProperty: "error" },
  );
  const granted = client.evidence(input.lease);
  if (
    original.binding.nonce !== input.nonce ||
    !equal(granted.binding, client.binding(pending)) ||
    !Number.isSafeInteger(granted.generation) ||
    granted.generation < 1
  )
    throw Error("Original native lease does not hold this gateway attempt.");
  const captured = await withMobilePublicationOwner(
    input.proof,
    async ({ authority, paths }, signal) => {
      const state = await authority.registry(signal).read();
      if (state.schemaVersion !== 3) throw Error("Native admission requires original journal.");
      const attempt = state.mobile.gatewayLifecycle?.attempts.find((a) => a.nonce === input.nonce),
        stage = state.mobile.stages.find((s) => s.id === paths.stageId);
      if (
        !attempt ||
        !stage ||
        !state.mobile.consent.enabled ||
        state.mobile.consent.revision !== paths.consentRevision ||
        attempt.phase !== "attempted" ||
        !equal(attempt.nativeOwnership, original) ||
        attempt.stageId !== paths.stageId ||
        attempt.releaseId !== paths.releaseId ||
        attempt.consentRevision !== paths.consentRevision ||
        // The current controller: this instance started it, or durably adopted it as successor.
        !equal(attempt.currentController ?? attempt.controller, authority.controller) ||
        attempt.configuration.port !== input.port ||
        attempt.configuration.externalOrigin !== input.externalOrigin
      )
        throw new MobileGatewayNativeAdmissionRefused(
          "Original attempted native gateway admission unavailable.",
        );
      return { authority, paths, attempt, stage };
    },
    input.signal,
  );
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  let live = true;
  const assertLive = () => {
    signal.throwIfAborted();
    assertMobilePublicationAuthority(captured.authority);
    if (!live) throw Error("Native gateway admission is closed.");
  };
  const binding = async () => {
    const current = await input.owners.getBinding(
      localSupervisorTarget(captured.paths.owner.authority.authorityId),
    );
    if (
      !current ||
      remoteAgentBuildId(current.runtime) !== captured.attempt.binding.buildId ||
      current.runtime.generation !== captured.attempt.binding.generation ||
      current.expectedEpoch !== captured.attempt.binding.epoch ||
      current.connectionId !== captured.attempt.binding.connectionId
    )
      throw Error("Canonical native gateway agent binding changed.");
  };
  const durable = async () => {
    const state = await readMobileGatewayAdmissionRegistry(captured.authority.root);
    if (
      state.schemaVersion !== 3 ||
      !mobileRegistryOwnerEqual(state.mobile.owner, captured.paths.owner) ||
      !state.mobile.consent.enabled
    )
      throw Error("Durable native gateway consent ended.");
    if (state.mobile.consent.revision !== captured.paths.consentRevision)
      throw new MobileGatewayAdmissionRevoked("Durable mobile consent revision changed.");
    if (
      !equal(
        state.mobile.stages.find((s) => s.id === captured.stage.id),
        captured.stage,
      ) ||
      !equal(
        state.mobile.gatewayLifecycle?.attempts.find((a) => a.nonce === input.nonce),
        captured.attempt,
      ) ||
      !state.pins.some(
        (p) =>
          p.owner === mobileGatewayBuildPin(input.nonce) &&
          p.buildId === captured.attempt.binding.buildId,
      )
    )
      throw Error("Current attempted native gateway admission ended.");
  };
  const native = async () => {
    // One status round-trip; the owner client keeps its own 20 s IO bound. Throw = uncertain.
    const status = await client.reconcile(pending, signal);
    if (status.state !== "live") throw Error("Original native gateway scope is not live.");
    if (client.evidence(status.lease).generation !== granted.generation)
      throw new MobileGatewayAdmissionRevoked("Original native gateway generation changed.");
  };
  const batch = mobileGatewayAdmissionBatch<RemoteMobileAdmissionStamp>({
    assertLive,
    work: async () => {
      assertLive();
      await captured.authority.assertAuthority();
      await binding();
      assertLive();
      await durable();
      assertLive();
      await native();
      assertLive();
      return Object.freeze({
        authority: captured.paths.owner.authority,
        installationFingerprint: captured.paths.owner.installationFingerprint,
        consentRevision: captured.paths.consentRevision,
        backendExternalOrigin: input.externalOrigin,
      });
    },
  });
  return Object.freeze({
    read: batch.read,
    /** Ends admission first, then settles every accepted read, cancelling native observation. */
    close: async () => {
      live = false;
      lifetime.abort(Error("Native gateway admission closed."));
      await batch.settle();
    },
  });
}

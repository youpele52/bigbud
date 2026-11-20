import type { ChildProcess } from "node:child_process";
import type { MobileGatewaySupervisor } from "@bigbud/shared/mobileGatewaySupervisor";
import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";
import type { RemoteMobileAdmissionStamp } from "./mobileGatewayStatus.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import { withMobilePublicationOwner } from "../remote-agent/mobileGatewayLifecycle.publication.ts";
import { currentMobileGatewayBinding } from "../remote-agent/mobileGatewayLifecycle.binding.ts";
import { assertMobilePublicationAuthority } from "../remote-agent/mobileOptionalPublication.authority.ts";
import { mobileRegistryOwnerEqual } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import { mobileGatewayBuildPin } from "../remote-agent/mobileGatewayLifecycle.transitions.ts";
import { remoteAgentBuildId } from "../remote-agent/remoteAgentRuntime.ts";
import { localSupervisorTarget } from "./localSupervisorIdentity.ts";
import {
  verifyMobileGatewayAssets,
  type OwnedMobileGatewayAssets,
} from "./mobileGatewayProcess.assets.ts";
import { probeMobileGateway } from "./mobileGatewayProbe.ts";
import {
  mobileGatewayAdmissionBatch,
  readMobileGatewayAdmissionRegistry,
} from "./mobileGatewayAdmission.batch.ts";

export async function mobileGatewayProcessAdmission(input: {
  readonly proof: VerifiedMobilePublication;
  readonly nonce: string;
  readonly port: number;
  readonly externalOrigin: string;
  readonly expected: RemoteBackendMobileDescriptor;
  readonly owners: RemoteAgentOwnerStore;
  readonly child: ChildProcess;
  readonly supervisor: MobileGatewaySupervisor;
  readonly signal: AbortSignal;
  readonly assertSocket: () => void;
  readonly assets: OwnedMobileGatewayAssets;
}) {
  const captured = await withMobilePublicationOwner(
    input.proof,
    async ({ authority, paths }, signal) => {
      const state = await authority.registry(signal).read();
      if (state.schemaVersion !== 3) throw Error("Gateway admission requires original journal.");
      const attempt = state.mobile.gatewayLifecycle?.attempts.find((a) => a.nonce === input.nonce),
        stage = state.mobile.stages.find((s) => s.id === paths.stageId);
      if (
        !attempt ||
        !stage ||
        attempt.phase !== "child-owned" ||
        attempt.child?.pid !== input.child.pid ||
        attempt.stageId !== paths.stageId ||
        attempt.releaseId !== paths.releaseId ||
        attempt.consentRevision !== paths.consentRevision ||
        JSON.stringify(attempt.controller) !== JSON.stringify(authority.controller) ||
        attempt.configuration.port !== input.port ||
        attempt.configuration.externalOrigin !== input.externalOrigin
      )
        throw Error("Original child-owned gateway admission unavailable.");
      return { authority, paths, attempt, stage };
    },
    input.signal,
  );
  let live = true;
  const assertLive = () => {
    input.signal.throwIfAborted();
    assertMobilePublicationAuthority(captured.authority);
    if (
      !live ||
      input.child.exitCode !== null ||
      input.child.signalCode !== null ||
      input.supervisor.getStatus() !== "ready"
    )
      throw Error("Verified gateway process is no longer live.");
    input.assertSocket();
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
      throw Error("Canonical gateway agent binding changed.");
  };
  const batch = mobileGatewayAdmissionBatch<RemoteMobileAdmissionStamp>({
    assertLive,
    work: async () => {
      assertLive();
      await captured.authority.assertAuthority();
      await binding();
      assertLive();
      const state = await readMobileGatewayAdmissionRegistry(captured.authority.root);
      assertLive();
      if (
        state.schemaVersion !== 3 ||
        !mobileRegistryOwnerEqual(state.mobile.owner, captured.paths.owner) ||
        !state.mobile.consent.enabled ||
        state.mobile.consent.revision !== captured.paths.consentRevision ||
        JSON.stringify(state.mobile.stages.find((s) => s.id === captured.stage.id)) !==
          JSON.stringify(captured.stage) ||
        JSON.stringify(
          state.mobile.gatewayLifecycle?.attempts.find((a) => a.nonce === input.nonce),
        ) !== JSON.stringify(captured.attempt) ||
        !state.pins.some(
          (p) =>
            p.owner === mobileGatewayBuildPin(input.nonce) &&
            p.buildId === captured.attempt.binding.buildId,
        )
      )
        throw Error("Current durable gateway admission ended.");
      return Object.freeze({
        authority: captured.paths.owner.authority,
        installationFingerprint: captured.paths.owner.installationFingerprint,
        consentRevision: captured.paths.consentRevision,
        backendExternalOrigin: input.externalOrigin,
      });
    },
  });
  const full = () =>
    withMobilePublicationOwner(
      input.proof,
      async ({ authority, revalidate }, ownedSignal) => {
        const signal = AbortSignal.any([input.signal, ownedSignal]);
        assertLive();
        await binding();
        const observed = await currentMobileGatewayBinding(authority, input.owners, signal);
        if (JSON.stringify(observed) !== JSON.stringify(captured.attempt.binding))
          throw Error("Live canonical gateway epoch changed.");
        await verifyMobileGatewayAssets(input.assets, signal);
        await probeMobileGateway({
          port: input.port,
          externalOrigin: input.externalOrigin,
          expected: input.expected,
          signal,
        });
        await revalidate();
        assertLive();
      },
      input.signal,
    );
  return {
    read: batch.read,
    full,
    close: async () => {
      live = false;
      await batch.settle();
    },
  };
}

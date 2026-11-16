import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { MobileGatewaySupervisor } from "@bigbud/shared/mobileGatewaySupervisor";
import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";
import type { RemoteMobileAdmissionStamp } from "./mobileGatewayStatus.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import { withMobilePublicationOwner } from "../remote-agent/mobileGatewayLifecycle.publication.ts";
import { currentMobileGatewayBinding } from "../remote-agent/mobileGatewayLifecycle.binding.ts";
import { assertMobilePublicationAuthority } from "../remote-agent/mobileOptionalPublication.authority.ts";
import {
  MAX_REMOTE_AGENT_REGISTRY_BYTES,
  parseRemoteAgentRegistry,
} from "../remote-agent/remoteAgentInstall.registry.ts";
import { mobileRegistryOwnerEqual } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import { mobileGatewayBuildPin } from "../remote-agent/mobileGatewayLifecycle.transitions.ts";
import { remoteAgentBuildId } from "../remote-agent/remoteAgentRuntime.ts";
import { localSupervisorTarget } from "./localSupervisorIdentity.ts";
import { readLocalSupervisorServiceFile } from "./localSupervisorService.files.ts";
import {
  verifyMobileGatewayAssets,
  type OwnedMobileGatewayAssets,
} from "./mobileGatewayProcess.assets.ts";
import { probeMobileGateway } from "./mobileGatewayProbe.ts";

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
  interface Batch {
    readonly promise: Promise<RemoteMobileAdmissionStamp>;
    readonly resolve: (stamp: RemoteMobileAdmissionStamp) => void;
    readonly reject: (cause: unknown) => void;
    sealed: boolean;
  }
  let active: Batch | undefined, queued: Batch | undefined;
  const accepted = new Set<Promise<RemoteMobileAdmissionStamp>>();
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
  const createBatch = (): Batch => {
    let resolve!: (stamp: RemoteMobileAdmissionStamp) => void, reject!: (cause: unknown) => void;
    const promise = new Promise<RemoteMobileAdmissionStamp>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    accepted.add(promise);
    void promise.catch(() => {});
    return { promise, resolve, reject, sealed: false };
  };
  const runBatch = (batch: Batch): void => {
    void Promise.resolve()
      .then(async () => {
        batch.sealed = true; // Every member arrived before this batch's fresh async guards/read.
        assertLive();
        await captured.authority.assertAuthority();
        await binding();
        assertLive();
        const text = await readLocalSupervisorServiceFile(
          join(captured.authority.root, "control-v1", "registry.json"),
          MAX_REMOTE_AGENT_REGISTRY_BYTES,
        );
        const state = parseRemoteAgentRegistry(text);
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
      })
      .then(batch.resolve, batch.reject)
      .finally(() => {
        accepted.delete(batch.promise);
        if (active === batch) active = undefined;
        if (queued) {
          const next = queued;
          queued = undefined;
          active = next;
          runBatch(next);
        }
      });
  };
  const read = (external?: AbortSignal): Promise<RemoteMobileAdmissionStamp> => {
    try {
      external?.throwIfAborted();
      assertLive();
    } catch (cause) {
      return Promise.reject(cause);
    }
    let batch: Batch;
    if (!active) {
      batch = createBatch();
      active = batch;
      runBatch(batch);
    } else if (!active.sealed) batch = active;
    else {
      queued ??= createBatch();
      batch = queued;
    }
    const shared = batch.promise;
    if (!external) return shared;
    const waiter = new Promise<RemoteMobileAdmissionStamp>((resolve, reject) => {
      const abort = () => reject(external.reason);
      external.addEventListener("abort", abort, { once: true });
      void shared.then(
        (value) => {
          external.removeEventListener("abort", abort);
          if (external.aborted) reject(external.reason);
          else resolve(value);
        },
        (cause) => {
          external.removeEventListener("abort", abort);
          reject(cause);
        },
      );
      if (external.aborted) abort();
    });
    void waiter.catch(() => {});
    return waiter;
  };
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
    read,
    full,
    close: async () => {
      live = false;
      await Promise.allSettled(accepted);
    },
  };
}

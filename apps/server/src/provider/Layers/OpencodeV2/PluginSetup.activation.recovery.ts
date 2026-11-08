import path from "node:path";
import { realpath } from "node:fs/promises";
import type { V2OwnedActivationJob } from "./PluginSetup.activation.jobs.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import type { V2BackendInstance } from "./Orchestration.instances.ts";
import { readV2OwnerMarker } from "./Orchestration.instances.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";
import {
  decodeV2EnrollmentRecord,
  digestV2EnrollmentOwner,
} from "./Orchestration.enrollment.record.ts";
import { v2OwnerRegistration, v2ThreadRegistration } from "./Orchestration.registration.ts";
import {
  prepareV2DeadBackendRecovery,
  settleV2PreviousRetirement,
} from "./Orchestration.enrollment.deadBackend.ts";

/** Upgrade preparation shares the ordinary restart proof; the idle observer never performs cleanup. */
export class V2ActivationRecovery {
  constructor(private readonly backend?: V2BackendInstance) {}

  private async records(artifact: V2PluginSetupArtifact) {
    const backend = this.backend;
    if (!backend)
      throw new Error(
        "V2 installation recovery requires the backend state-directory lock; restart bigbud.",
      );
    await backend.assertHeld();
    if ((await realpath(backend.stateDir)) !== (await realpath(path.dirname(artifact.root))))
      throw new Error("V2 installation recovery belongs to another application profile.");
    return V2ThreadRecords.open(
      artifact.root,
      "enrollments",
      artifact.privateKey,
      artifact.publicKey,
    );
  }

  private async owners(records: V2ThreadRecords, artifact: V2PluginSetupArtifact) {
    const id = v2ThreadRegistration(artifact).id;
    return (await records.entries()).flatMap((signed) => {
      const value = decodeV2EnrollmentRecord(signed.value);
      if (digestV2EnrollmentOwner(value.owner) !== value.digest)
        throw new Error("V2 retained owner signature scope is inconsistent; evidence preserved.");
      return v2OwnerRegistration(value.owner).id === id ? [{ signed, ...value }] : [];
    });
  }

  /** Current same-host provenance authorizes exact metadata adoption, never a claimed reboot. */
  async assertInstallationOwner(artifact: V2PluginSetupArtifact) {
    const records = await this.records(artifact);
    const owners = await this.owners(records, artifact);
    if (!owners.length)
      throw new Error(
        "V2 installation identity needs backed-up maintenance: no same-host owner provenance is available.",
      );
    for (const { owner, digest } of owners) {
      const marker = await readV2OwnerMarker(records, digest);
      if (
        !marker ||
        marker.enrollmentNonce !== owner.enrollmentNonce ||
        (marker.backendInstance !== this.backend!.nonce &&
          this.backend!.classifyOwner(marker) !== "dead")
      )
        throw new Error(
          "V2 installation identity needs backed-up maintenance: previous owner host is unconfirmed.",
        );
    }
    await this.backend!.assertHeld();
  }

  async retire(
    job: V2OwnedActivationJob,
    artifact: V2PluginSetupArtifact,
    participants: ReadonlyMap<string, unknown>,
    signal: AbortSignal,
  ) {
    if (!this.backend) return; // Preserve the existing fail-closed gate when no backend authority exists.
    signal.throwIfAborted();
    job.assertCurrent();
    const records = await this.records(artifact);
    const recovery = await prepareV2DeadBackendRecovery({
      stateDir: this.backend.stateDir,
      instance: this.backend,
      records,
      privateKey: artifact.privateKey,
    });
    const context = recovery?.context(job.connection.client, job.scope.transport);
    const retirement = await V2EnrollmentRetirement.open(records);
    for (const { signed, owner, digest } of await this.owners(records, artifact)) {
      signal.throwIfAborted();
      job.assertCurrent();
      if (participants.has(digest)) continue;
      const identity = {
        wireProtocol: owner.protocol,
        ownerDigest: digest,
        enrollmentNonce: owner.enrollmentNonce,
        directory: owner.directory,
        nativeSessionId: owner.nativeSessionId,
      };
      if (
        await retirement.assertSettled(identity).then(
          () => true,
          () => false,
        )
      )
        continue;
      if (owner.storageIdentity !== job.scope.descriptor.storageIdentity)
        throw new Error(
          "V2 plugin upgrade is blocked by retained ownership in another native storage; restore its original service.",
        );
      await settleV2PreviousRetirement(records, signed, identity, context);
      signal.throwIfAborted();
      job.assertCurrent();
    }
  }
}

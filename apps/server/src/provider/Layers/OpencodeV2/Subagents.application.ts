import { exportV2NativeFamilyArtifact } from "./Subagents.artifact.ts";
import { V2NativeFamilyBridge } from "./Subagents.bridge.ts";
import {
  selectV2NativeFamilyQualification,
  V2_NATIVE_FAMILY_QUALIFICATIONS,
  type NativeFamilyQualification,
} from "./Subagents.qualification.ts";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { readV2RetainedArtifact } from "./Orchestration.artifact.retained.ts";
import { assertV2NativeThreadSource } from "./Orchestration.readiness.source.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import { currentV2RequestContext } from "./Client.guard.ts";

/** Actual application factory. Release evidence gates construction; loaded native bytes gate attachment. */
export function makeV2NativeFamilyPreparation(
  stateDir: string,
  records: readonly NativeFamilyQualification[] = V2_NATIVE_FAMILY_QUALIFICATIONS,
) {
  let broker: Promise<V2NativeFamilyBridge> | undefined,
    closed = false;
  return {
    prepare: async (owner: V2RuntimeSession, runtime: OpencodeV2Runtime) => {
      if (closed) throw new Error("V2 native family application broker is closed.");
      if (!records.length || !owner.localTools) return;
      const proof = owner.activation?.stamp.nativeProof;
      if (!proof) return;
      proof.assertCurrent();
      if (
        proof.directory !== owner.native.location.directory ||
        proof.transport !== (owner.sharedTransport ?? owner.storageIdentity) ||
        proof.generation !==
          (runtime.options.config.sharedService?.generation ?? String(owner.lease.generation)) ||
        proof.consentRevision !==
          (owner.consentPermit?.revision ?? currentV2RequestContext()?.permit.revision ?? 0)
      )
        throw new Error("V2 native family qualification scope differs from its root.");
      const artifact = await exportV2NativeFamilyArtifact(stateDir);
      const record = selectV2NativeFamilyQualification(proof, artifact.artifactDigest, records);
      if (!record) return;
      if (
        record.syntheticAdmission !== "unsupported" &&
        (!record.nativeFamilySourceDigest ||
          proof.nativeFamilySourceDigest !== record.nativeFamilySourceDigest)
      )
        throw new Error("V2 native family extension source lacks exact release qualification.");
      if (owner.native.metadata?.bigbud_issuer !== artifact.issuer)
        throw new Error("V2 native family root issuer differs from signed guard.");
      broker ??= V2NativeFamilyBridge.open(artifact);
      const bridge = await broker;
      if (closed) {
        await bridge.close();
        throw new Error("V2 native family broker closed during setup.");
      }
      const latest = await exportV2ThreadArtifact(stateDir);
      const canonical = await readV2RetainedArtifact(
        latest,
        owner.activation!.stamp.bootstrapDigest,
      );
      const verifyCanonical = async () => {
        await canonical.verify();
        await assertV2NativeThreadSource(canonical, owner.lease.process.client, proof.directory);
        proof.assertCurrent();
      };
      return bridge.qualification(owner, runtime, proof, record, verifyCanonical);
    },
    close: async () => {
      closed = true;
      await broker?.then((value) => value.close());
    },
  };
}

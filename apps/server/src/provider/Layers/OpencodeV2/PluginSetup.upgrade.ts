import { V2ThreadRecords } from "./Orchestration.records.ts";
import { v2ThreadRegistration, v2OwnerRegistration } from "./Orchestration.registration.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import {
  decodeV2EnrollmentRecord,
  digestV2EnrollmentOwner,
} from "./Orchestration.enrollment.record.ts";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";

/** Lease expiry/registry absence never replaces exact signed owner and durable physical retirement proof. */
export async function assertV2PluginUpgradeIdle(artifact: V2PluginSetupArtifact) {
  const records = await V2ThreadRecords.open(
    artifact.root,
    "enrollments",
    artifact.privateKey,
    artifact.publicKey,
  );
  const retirements = await V2EnrollmentRetirement.open(records);
  for (const entry of await records.entries()) {
    const value = decodeV2EnrollmentRecord(entry.value);
    if (digestV2EnrollmentOwner(value.owner) !== value.digest)
      throw new Error("V2 required-plugin upgrade owner evidence is invalid; retained.");
    if (v2OwnerRegistration(value.owner).id !== v2ThreadRegistration(artifact).id) continue;
    await retirements.assertSettled({
      wireProtocol: value.owner.protocol,
      ownerDigest: value.digest,
      enrollmentNonce: value.owner.enrollmentNonce,
      directory: value.owner.directory,
      nativeSessionId: value.owner.nativeSessionId,
    });
  }
}

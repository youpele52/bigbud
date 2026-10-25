import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import {
  decodeV2EnrollmentRecord,
  digestV2EnrollmentOwner,
} from "./Orchestration.enrollment.record.ts";
import { readV2RetainedArtifact } from "./Orchestration.artifact.retained.ts";
import { V2_COMPACT_NATIVE_SESSION_PREFIX } from "./Orchestration.sessionIdentity.ts";
import { V2_SCOPED_BOOTSTRAP_ABI } from "./Orchestration.registration.ts";
import {
  v2OwnerRegistration,
  v2ThreadRegistration,
  type V2RegistrationFamily,
} from "./Orchestration.registration.ts";

export interface V2SessionRegistrationIdentity {
  readonly threadId: string;
  readonly nativeSessionId: string;
  readonly storageIdentity: string;
  readonly directory: string;
  readonly registrationFamily: V2RegistrationFamily;
}

/** Compact sessions cannot borrow an older bootstrap that forgets their namespace after reload. */
export function assertV2SessionBootstrap(artifact: V2PluginSetupArtifact, nativeSessionId: string) {
  if (
    nativeSessionId.startsWith(V2_COMPACT_NATIVE_SESSION_PREFIX) &&
    artifact.bootstrapAbi !== V2_SCOPED_BOOTSTRAP_ABI
  )
    throw new Error(
      "V2 compact native history requires its namespace-aware bootstrap; no downgrade or replacement.",
    );
}

/** Select from signed same-profile history before activation; native inventory never chooses a family. */
export async function selectV2SessionArtifact(
  preferred: V2PluginSetupArtifact,
  records: V2ThreadRecords,
  identity: V2SessionRegistrationIdentity,
) {
  const digests = new Set<string>();
  for (const entry of await records.entries()) {
    const record = decodeV2EnrollmentRecord(entry.value),
      owner = record.owner;
    if (owner.nativeSessionId !== identity.nativeSessionId) continue;
    if (
      digestV2EnrollmentOwner(owner) !== record.digest ||
      owner.issuer !== preferred.issuer ||
      owner.threadId !== identity.threadId ||
      owner.storageIdentity !== identity.storageIdentity ||
      owner.directory !== identity.directory ||
      v2OwnerRegistration(owner).family !== identity.registrationFamily
    )
      throw new Error(
        "V2 retained signed registration conflicts; history remains read-only without cross-family enrollment.",
      );
    if (owner.protocol === "bigbud.thread.v1")
      throw new Error(
        "V2 historical bootstrap is cleanup-only; retained history remains read-only.",
      );
    digests.add(owner.bootstrapDigest);
  }
  if (digests.size > 1 || (!digests.size && identity.registrationFamily === "legacy"))
    throw new Error(
      "V2 retained bootstrap identity is unproved or ambiguous; restore exact same-profile evidence. No replacement or replay.",
    );
  const digest = [...digests][0];
  const artifact = digest ? await readV2RetainedArtifact(preferred, digest) : preferred;
  assertV2SessionBootstrap(artifact, identity.nativeSessionId);
  if (v2ThreadRegistration(artifact).family !== identity.registrationFamily)
    throw new Error("V2 cross-family native session enrollment is forbidden.");
  return artifact;
}

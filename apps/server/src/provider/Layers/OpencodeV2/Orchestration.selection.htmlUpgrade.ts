import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import { readV2RetainedArtifact } from "./Orchestration.artifact.retained.ts";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";
import type { decodeV2EnrollmentRecord } from "./Orchestration.enrollment.record.ts";

/** Only settled, same-profile scoped histories may adopt the new bootstrap ABI. No signed owner is rewritten. */
export async function selectV2HtmlBootstrapUpgrade(
  preferred: V2PluginSetupArtifact,
  records: V2ThreadRecords,
  owners: ReadonlyArray<ReturnType<typeof decodeV2EnrollmentRecord>>,
): Promise<V2PluginSetupArtifact | undefined> {
  if (
    !["bigbud.thread.bootstrap.v4", "bigbud.thread.bootstrap.v5"].includes(
      preferred.bootstrapAbi,
    ) ||
    !owners.length
  )
    return;
  const retirements = await V2EnrollmentRetirement.open(records);
  for (const record of owners) {
    const owner = record.owner;
    if (owner.protocol !== "bigbud.thread.enrollment.v2") return;
    if (owner.bootstrapDigest === preferred.bootstrapDigest) continue;
    const retained = await readV2RetainedArtifact(preferred, owner.bootstrapDigest);
    if (
      owner.bootstrapAbi !== retained.bootstrapAbi ||
      owner.compatibilityDigest !== retained.compatibilityDigest
    )
      throw new Error("V2 retained owner/bootstrap migration evidence conflicts.");
    if (
      retained.bootstrapAbi !== "bigbud.thread.bootstrap.v3" &&
      !(
        preferred.bootstrapAbi === "bigbud.thread.bootstrap.v5" &&
        retained.bootstrapAbi === "bigbud.thread.bootstrap.v4"
      )
    )
      return;
    try {
      await retirements.assertSettled({
        wireProtocol: owner.protocol,
        ownerDigest: record.digest,
        enrollmentNonce: owner.enrollmentNonce,
        directory: owner.directory,
        nativeSessionId: owner.nativeSessionId,
      });
    } catch {
      // Active/uncertain owners keep the old surface. Expiry and local revoked state are not proof.
      return;
    }
  }
  return preferred;
}

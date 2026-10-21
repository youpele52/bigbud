import path from "node:path";
import { exportV2NativeFamilyArtifact } from "./Subagents.artifact.ts";
import {
  V2_NATIVE_FAMILY_QUALIFICATIONS,
  selectV2NativeFamilyQualification,
} from "./Subagents.qualification.ts";
import { publishV2NativeFamilyArtifact } from "./Subagents.publication.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import type { OpencodeV2Client } from "./Client.ts";
import type { V2NativeEligibilityVerifier } from "./NativeCompatibility.runtime.ts";
import { assertV2PluginRegistrationEnabled } from "./PluginSetup.policy.ts";
import { verifyV2NativeFamilySource } from "./Subagents.readiness.ts";
import { v2Request } from "./Client.ts";

/** Called inside the canonical activation transaction with its real publication authority.
 * No release evidence means no additional native write, registration or widening.
 */
export async function setupV2NativeFamily(
  canonical: V2PluginSetupArtifact,
  client: OpencodeV2Client,
  directory: string,
  root: string,
  authority: V2PluginSetupAuthority,
  configured: readonly string[],
  eligibility: V2NativeEligibilityVerifier,
) {
  if (!V2_NATIVE_FAMILY_QUALIFICATIONS.length) return;
  const artifact = await exportV2NativeFamilyArtifact(path.dirname(canonical.root));
  const proof = await eligibility(canonical, client, directory, root, authority.signal);
  if (!selectV2NativeFamilyQualification(proof, artifact.artifactDigest)) return;
  assertV2PluginRegistrationEnabled(configured, artifact.rpcID);
  const inventory = await v2Request("native family setup inventory", (signal) =>
    client.plugin.list({ location: { directory } }, { signal }),
  );
  if (inventory.data.some((plugin) => plugin.id === artifact.rpcID)) {
    await verifyV2NativeFamilySource(artifact, client, proof);
    return;
  }
  if (!authority.publication)
    throw new Error(
      "V2 native family guard needs an explicit activation writer; no automatic manual-path installation.",
    );
  await publishV2NativeFamilyArtifact(artifact, root, authority, canonical);
  await verifyV2NativeFamilySource(artifact, client, proof);
}

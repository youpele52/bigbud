import { createHash } from "node:crypto";
import type { OpencodeV2Client } from "./Client.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import type { V2NativeEligibilityVerifier } from "./NativeCompatibility.runtime.ts";
import type { V2NativeSemanticProfile } from "./NativeCompatibility.types.ts";
import { V2NativeCompatibilityError } from "./NativeCompatibility.types.ts";
import { V2_NATIVE_CONTRACT_DIGEST } from "./NativeCompatibility.contract.ts";
import { parseV2CanonicalCandidate } from "./NativeCompatibility.version.ts";
import { assertV2CanonicalNativeApi } from "./NativeCompatibility.api.ts";
import { v2CanonicalApiFixture } from "./NativeCompatibility.api.fixture.ts";
import { currentV2RequestContext } from "./Client.guard.ts";

/** Source-unit ticket bound to synthetic client/root/generation/suite. This is not a retail
 * candidate ticket or completed qualification; no production composition imports this module. */
export function makeV2SyntheticNativeEligibility(
  client: OpencodeV2Client,
  artifact: V2PluginSetupArtifact,
  root: string,
  nativeVersion = "2.0.26",
  semanticProfile: V2NativeSemanticProfile = "v2-global-config-v1",
): V2NativeEligibilityVerifier {
  const generation = "synthetic-native-generation",
    suite = "source-unit-only",
    syntheticImage = "0".repeat(64);
  const id = createHash("sha256")
    .update(JSON.stringify([artifact.root, root, generation, nativeVersion, syntheticImage, suite]))
    .digest("hex");
  return async (selected, incoming, directory, requestedRoot, signal) => {
    signal?.throwIfAborted();
    currentV2RequestContext()?.permit.assertCurrent();
    if (
      incoming !== client ||
      selected.root !== artifact.root ||
      requestedRoot !== root ||
      !parseV2CanonicalCandidate(nativeVersion) ||
      (selected.compatibility.format === "bigbud.thread.compatibility.v1" &&
        !selected.compatibility.qualifiedVersions.includes(nativeVersion))
    )
      throw new V2NativeCompatibilityError(
        "native-generation-changed",
        "synthetic fixture ticket does not cover this client/root/version/bootstrap.",
        nativeVersion,
      );
    return Object.freeze({
      evidenceKind: "candidate" as const,
      assertConfigRead: () => currentV2RequestContext()?.permit.assertCurrent(),
      assertCurrent: () => currentV2RequestContext()?.permit.assertCurrent(),
      transport: "synthetic-only",
      generation,
      nativeVersion,
      platform: "darwin",
      arch: "arm64",
      nativeContractDigest: V2_NATIVE_CONTRACT_DIGEST,
      semanticProfile,
      qualificationRecordId: id,
      consumedApiDigest: assertV2CanonicalNativeApi(v2CanonicalApiFixture(), nativeVersion),
      directory,
      root,
      consentRevision: currentV2RequestContext()?.permit.revision ?? 1,
      compatibilityDigest: selected.compatibilityDigest,
    });
  };
}

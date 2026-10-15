import { createHash } from "node:crypto";
import path from "node:path";
import type { OpencodeV2Client } from "./Client.ts";
import type { V2NativeEligibilityVerifier } from "./NativeCompatibility.runtime.ts";
import type { V2NativeSemanticProfile } from "./NativeCompatibility.types.ts";
import type { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import {
  requireV2NativeIsolation,
  verifyV2NativeFixtureImage,
} from "./SharedService.native.isolation.fixture.ts";
import {
  readV2SharedRegistration,
  sameV2SharedRegistration,
  v2SharedGeneration,
} from "./SharedService.registration.ts";
import { readV2SharedServiceJson } from "./SharedService.discovery.ts";
import { assertV2CanonicalNativeApi } from "./NativeCompatibility.api.ts";
import { V2_NATIVE_CONTRACT_DIGEST } from "./NativeCompatibility.contract.ts";
import { currentV2RequestContext } from "./Client.guard.ts";
import { v2NativeCompatibilityBinding } from "./NativeCompatibility.binding.ts";
import { readV2OwnedRetailChild } from "./SharedService.native.child.fixture.ts";

/** Explicit frozen harness metadata accompanies independent clean-machine approval. These inputs
 * identify a candidate suite; they can never populate the production completed registry. */
export function v2NativeCandidateFixtureVerifier(
  native: Awaited<ReturnType<typeof sharedServiceNativeFixture>>,
  client: OpencodeV2Client,
  suite: string,
) {
  const digest = process.env.BIGBUD_OPENCODE_V2_CANDIDATE_SOURCE_SNAPSHOT_DIGEST,
    profile = process.env.BIGBUD_OPENCODE_V2_CANDIDATE_SEMANTIC_PROFILE;
  if (!digest || !["v2-global-config-v1", "v2-system-global-config-v1"].includes(profile ?? ""))
    throw new Error(
      "V2 candidate requires frozen source digest and explicit reviewed semantic profile; no guessed qualification.",
    );
  return makeV2OwnedCandidateEligibility(
    native,
    client,
    suite,
    digest,
    profile as V2NativeSemanticProfile,
  );
}

/** Candidate execution exists only in an approved owned retail harness; it cannot produce a
 * completed release record. Production composition does not import this fixture module. */
export function makeV2OwnedCandidateEligibility(
  native: Awaited<ReturnType<typeof sharedServiceNativeFixture>>,
  client: OpencodeV2Client,
  suiteRevision: string,
  sourceSnapshotDigest: string,
  semanticProfile: V2NativeSemanticProfile,
): V2NativeEligibilityVerifier {
  if (!/^[a-f0-9]{64}$/.test(sourceSnapshotDigest) || !suiteRevision || suiteRevision.length > 200)
    throw new Error("V2 candidate harness/source identity is missing.");
  const { approval } = native,
    pid = native.child.pid;
  const ticket = readV2OwnedRetailChild(native.child);
  const root = path.dirname(native.configFile),
    inside = (value: string) =>
      path.resolve(value) === value && value.startsWith(`${approval.fixtureRoot}${path.sep}`);
  let generation: string | undefined;
  if (ticket.approval !== approval || ticket.file !== native.file || ticket.root !== root)
    throw new Error("V2 candidate fixture differs from its factory-owned child ticket.");
  return async (artifact, incoming, directory, requestedRoot, signal) => {
    signal?.throwIfAborted();
    currentV2RequestContext()?.permit.assertCurrent();
    const binding = v2NativeCompatibilityBinding(incoming);
    if (
      (incoming !== client && binding?.descriptor.registrationFile !== native.file) ||
      requestedRoot !== root ||
      !inside(artifact.root) ||
      !inside(directory) ||
      native.child.pid !== pid ||
      native.child.exitCode !== null ||
      native.child.signalCode !== null
    )
      throw new Error("V2 candidate client/root/child scope changed; no execution.");
    if (readV2OwnedRetailChild(native.child) !== ticket)
      throw new Error("V2 candidate child ticket changed.");
    await requireV2NativeIsolation(approval.executablePath, approval.id);
    await verifyV2NativeFixtureImage(approval);
    const registration = await readV2SharedRegistration(native.file),
      observed = v2SharedGeneration(registration);
    if (
      registration.pid !== pid ||
      registration.version !== approval.nativeVersion ||
      observed !== ticket.generation ||
      (generation && generation !== observed)
    )
      throw new Error("V2 candidate frozen image/version/generation changed; no execution.");
    generation = observed;
    if (binding && binding.descriptor.generation !== observed)
      throw new Error("V2 candidate borrowed generation differs from the owned child.");
    binding?.assertCurrent();
    const info = await incoming.server.info(signal ? { signal } : {});
    if (info.pid !== pid || info.version !== approval.nativeVersion)
      throw new Error("V2 candidate native health differs from its approved image.");
    const contract = await readV2SharedServiceJson(
      registration,
      "/openapi.json",
      signal ? { signal } : {},
    );
    const consumedApiDigest = assertV2CanonicalNativeApi(contract, approval.nativeVersion);
    if (!sameV2SharedRegistration(registration, await readV2SharedRegistration(native.file)))
      throw new Error("V2 candidate registration changed during API verification.");
    if (
      artifact.compatibility.format === "bigbud.thread.compatibility.v1" &&
      !artifact.compatibility.qualifiedVersions.includes(approval.nativeVersion)
    )
      throw new Error("V2 candidate cannot widen retained N0's original version constraints.");
    const qualificationRecordId = createHash("sha256")
      .update(
        JSON.stringify([
          "bigbud.thread.native-candidate.v1",
          approval.environmentEvidenceDigest,
          approval.executableSha256,
          observed,
          suiteRevision,
          sourceSnapshotDigest,
        ]),
      )
      .digest("hex");
    signal?.throwIfAborted();
    currentV2RequestContext()?.permit.assertCurrent();
    return Object.freeze({
      evidenceKind: "candidate" as const,
      assertConfigRead: () => currentV2RequestContext()?.permit.assertNativeConfigRead?.(),
      assertCurrent: () => {
        binding?.assertCurrent();
        currentV2RequestContext()?.permit.assertCurrent();
        if (
          native.child.pid !== pid ||
          native.child.exitCode !== null ||
          native.child.signalCode !== null
        )
          throw new Error("V2 candidate child lifetime changed.");
      },
      transport: native.file,
      generation: observed,
      nativeVersion: approval.nativeVersion,
      platform: "darwin",
      arch: "arm64",
      nativeContractDigest: V2_NATIVE_CONTRACT_DIGEST,
      semanticProfile,
      qualificationRecordId,
      consumedApiDigest,
      directory,
      root,
      consentRevision: currentV2RequestContext()?.permit.revision ?? 0,
      compatibilityDigest: artifact.compatibilityDigest,
    });
  };
}

import type { OpencodeV2Client } from "./Client.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import { currentV2RequestContext, captureV2OperationAuthority } from "./Client.guard.ts";
import { v2Request } from "./Client.ts";
import {
  selectV2NativeConfigProfile,
  validateV2NativeConfigSources,
} from "./NativeCompatibility.sources.ts";
import { assertV2NativeSourcePolicy } from "./NativeCompatibility.policy.ts";
import { readV2SharedServiceJson } from "./SharedService.discovery.ts";
import {
  readV2SharedRegistration,
  sameV2SharedRegistration,
  v2SharedGeneration,
} from "./SharedService.registration.ts";
import { v2NativeCompatibilityBinding } from "./NativeCompatibility.binding.ts";
import {
  resolveV2NativeReleaseQualification,
  assertV2QualifiedBootstrap,
  assertV2RuntimeBootstrap,
} from "./NativeCompatibility.qualification.ts";
import { assertV2CanonicalNativeApi } from "./NativeCompatibility.api.ts";
import { parseV2CanonicalCandidate } from "./NativeCompatibility.version.ts";
import { V2_NATIVE_CONTRACT_DIGEST } from "./NativeCompatibility.contract.ts";
import { v2ThreadRegistration, type V2ThreadRegistration } from "./Orchestration.registration.ts";
import {
  V2NativeCompatibilityError,
  type V2NativeRuntimeProof,
} from "./NativeCompatibility.types.ts";

export type V2NativeEligibilityVerifier = typeof verifyV2NativeEligibility;

export type V2NativeReleaseProof = Omit<V2NativeRuntimeProof, "compatibilityDigest"> & {
  readonly bindBootstrap: (artifact: V2PluginSetupArtifact) => V2NativeRuntimeProof;
};

/** Fully bound runtime proof; semantic qualification is a distinct, optional evidence claim. */
export async function verifyV2NativeEligibility(
  artifact: V2PluginSetupArtifact,
  client: OpencodeV2Client,
  directory: string,
  root: string,
  signal?: AbortSignal,
): Promise<V2NativeRuntimeProof> {
  return (
    await verifyV2NativeReleaseEligibility(
      client,
      directory,
      root,
      signal,
      v2ThreadRegistration(artifact),
    )
  ).bindBootstrap(artifact);
}

/** Internal fixture composition supplies a verifier explicitly; production has no env/settings bypass. */
export async function verifyV2NativeReadOnlyEligibility(
  artifact: V2PluginSetupArtifact,
  client: OpencodeV2Client,
  directory: string,
  root: string,
  signal: AbortSignal | undefined,
  eligibility: V2NativeEligibilityVerifier,
) {
  return eligibility === verifyV2NativeEligibility
    ? verifyV2NativeReleaseEligibility(
        client,
        directory,
        root,
        signal,
        v2ThreadRegistration(artifact),
      )
    : eligibility(artifact, client, directory, root, signal);
}

/** Runtime checks precede activation/native intent. Absent semantic evidence warns; failed checks block. */
export async function verifyV2NativeReleaseEligibility(
  client: OpencodeV2Client,
  directory: string,
  root: string,
  signal?: AbortSignal,
  selectedRegistration?: V2ThreadRegistration,
): Promise<V2NativeReleaseProof> {
  const context = currentV2RequestContext(),
    binding = v2NativeCompatibilityBinding(client);
  const operation = captureV2OperationAuthority({
    signal: signal ?? new AbortController().signal,
    assertCurrent: () => {},
  });
  signal = operation.signal;
  if (
    !context ||
    context.intent !== "execute" ||
    !binding ||
    context.transport !== binding.descriptor.registrationFile
  )
    throw new V2NativeCompatibilityError(
      "native-generation-changed",
      "canonical compatibility requires the exact borrowed transport and execution consent.",
    );
  const assertCurrent = () => {
    operation.assertCurrent();
    signal?.throwIfAborted();
    context.permit.assertCurrent();
    binding.assertCurrent();
    if (currentV2RequestContext() !== context)
      throw new V2NativeCompatibilityError(
        "native-generation-changed",
        "compatibility request scope changed.",
      );
  };
  assertCurrent();
  const registration = await readV2SharedRegistration(binding.descriptor.registrationFile);
  assertCurrent();
  if (v2SharedGeneration(registration) !== binding.descriptor.generation)
    throw new V2NativeCompatibilityError(
      "native-generation-changed",
      "native registration generation changed.",
    );
  const info = await readV2SharedServiceJson(registration, "/api/info", signal ? { signal } : {});
  assertCurrent();
  if (
    !info ||
    typeof info !== "object" ||
    !("version" in info) ||
    !("pid" in info) ||
    info.version !== registration.version ||
    info.pid !== registration.pid
  )
    throw new V2NativeCompatibilityError(
      "native-generation-changed",
      "native health/registration versions do not agree.",
    );
  const version = registration.version;
  if (!parseV2CanonicalCandidate(version))
    throw new V2NativeCompatibilityError(
      "native-version-unsupported",
      "canonical tools require stable V2 with compatible APIs and bridge capabilities; independent model discovery is separate.",
      version,
    );
  const contract = await readV2SharedServiceJson(
    registration,
    "/openapi.json",
    signal ? { signal } : {},
  );
  assertCurrent();
  const consumedApiDigest = assertV2CanonicalNativeApi(contract, version);
  const qualified = resolveV2NativeReleaseQualification(version);
  const assertConfigRead = () => {
    context.permit.assertCurrent();
    if (!context.permit.assertNativeConfigRead)
      throw new V2NativeCompatibilityError(
        "config-source-unverified",
        "native configuration-read authority is missing.",
        version,
      );
    context.permit.assertNativeConfigRead();
  };
  assertCurrent();
  assertConfigRead();
  const sources = await v2Request(
    "canonical source profile",
    (abort) => client.config.get({ location: { directory } }, { signal: abort }),
    { signal, timeoutMs: 5000 },
  );
  assertCurrent();
  assertConfigRead();
  const semanticProfile =
    qualified?.record.semanticProfile ?? selectV2NativeConfigProfile(sources, root);
  validateV2NativeConfigSources(sources, root, semanticProfile);
  const proof = Object.freeze({
    evidenceKind: qualified ? ("qualified" as const) : ("runtime-checked" as const),
    assertConfigRead,
    assertCurrent: () => {
      binding.assertCurrent();
      // Released observers still expose revision validation, not write/RPC authority. Physical
      // callback completion can validate outside a request; actual native fetches require context.
      context.permit.assertCurrent();
      const current = currentV2RequestContext();
      if (
        current &&
        (current.intent !== "execute" ||
          current.transport !== binding.descriptor.registrationFile ||
          current.permit.revision !== context.permit.revision)
      )
        throw new V2NativeCompatibilityError(
          "native-generation-changed",
          "native compatibility proof lost its consent/transport scope.",
          version,
        );
      current?.permit.assertCurrent();
      current?.operationSignal?.throwIfAborted();
      // Evidence validation is a leaf: publication/admission guards themselves check this proof.
      // Invoking the dynamic operation guard here recurses back into this proof. Execution
      // authority still checks that guard in captureV2OperationAuthority and request issuance.
    },
    transport: binding.descriptor.registrationFile,
    generation: binding.descriptor.generation,
    nativeVersion: version,
    ...v2NativeRuntimePlatform(),
    nativeContractDigest: V2_NATIVE_CONTRACT_DIGEST,
    semanticProfile,
    ...(qualified ? { qualificationRecordId: qualified.id } : {}),
    ...(qualified?.record.nativeFamilySourceDigest
      ? { nativeFamilySourceDigest: qualified.record.nativeFamilySourceDigest }
      : {}),
    consumedApiDigest,
    directory,
    root,
    consentRevision: context.permit.revision,
  });
  await assertV2NativeSourcePolicy(sources, proof, signal, selectedRegistration);
  const final = await readV2SharedRegistration(binding.descriptor.registrationFile);
  assertCurrent();
  if (!sameV2SharedRegistration(registration, final))
    throw new V2NativeCompatibilityError(
      "native-generation-changed",
      "native registration changed during compatibility verification.",
      version,
    );
  return Object.freeze({
    ...proof,
    bindBootstrap: (artifact: V2PluginSetupArtifact) => {
      proof.assertCurrent();
      if (qualified) assertV2QualifiedBootstrap(qualified.record, artifact);
      else assertV2RuntimeBootstrap(version, artifact);
      return Object.freeze({ ...proof, compatibilityDigest: artifact.compatibilityDigest });
    },
  });
}
import { v2NativeRuntimePlatform } from "./NativeCompatibility.platform.ts";

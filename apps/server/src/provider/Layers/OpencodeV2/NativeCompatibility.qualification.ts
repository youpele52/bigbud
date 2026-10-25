import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { V2_NATIVE_CONTRACT_DIGEST } from "./NativeCompatibility.contract.ts";
import { parseV2CanonicalCandidate } from "./NativeCompatibility.version.ts";
import { v2NativeEvidenceKey, v2NativeRuntimePlatform } from "./NativeCompatibility.platform.ts";
import {
  V2_COMPATIBILITY_DIGEST,
  knownV2BootstrapCompatibility,
} from "./Orchestration.compatibility.ts";
import {
  V2_N0_COMPATIBILITY_DIGEST,
  V2_N1_COMPATIBILITY_DIGEST,
} from "./Orchestration.compatibility.legacy.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import {
  V2NativeQualificationRecord,
  V2NativeIncompatibleRecord,
  V2NativeCompatibilityError,
} from "./NativeCompatibility.types.ts";
import {
  V2_NATIVE_RELEASE_QUALIFICATIONS,
  V2_NATIVE_RELEASE_INCOMPATIBILITIES,
} from "./NativeCompatibility.qualification.registry.ts";

/** Pure registry validation also powers evidence --check; no runtime file/network/settings sources. */
export function validateV2NativeQualificationRegistry(
  passes: readonly unknown[],
  failures: readonly unknown[],
) {
  if (passes.length + failures.length > 128)
    throw new Error("V2 native qualification registry bound.");
  const qualified = new Map<string, { record: V2NativeQualificationRecord; id: string }>();
  const incompatible = new Map<string, V2NativeIncompatibleRecord>();
  for (const raw of passes) {
    const record = Schema.decodeUnknownSync(V2NativeQualificationRecord)(raw, {
      onExcessProperty: "error",
    });
    if (
      !parseV2CanonicalCandidate(record.nativeVersion) ||
      record.nativeContractDigest !== V2_NATIVE_CONTRACT_DIGEST ||
      new Date(record.completedAt).toISOString() !== record.completedAt ||
      new Set(record.bootstrapContractDigests).size !== record.bootstrapContractDigests.length ||
      record.bootstrapContractDigests.some(
        (digest) =>
          ![
            V2_COMPATIBILITY_DIGEST,
            V2_N0_COMPATIBILITY_DIGEST,
            V2_N1_COMPATIBILITY_DIGEST,
          ].includes(digest),
      ) ||
      qualified.has(v2NativeEvidenceKey(record.nativeVersion, record.platform, record.arch))
    )
      throw new Error("V2 native qualification record conflicts or has invalid evidence.");
    const id = createHash("sha256").update(JSON.stringify(record)).digest("hex");
    qualified.set(v2NativeEvidenceKey(record.nativeVersion, record.platform, record.arch), {
      record: Object.freeze({
        ...record,
        bootstrapContractDigests: Object.freeze([...record.bootstrapContractDigests]),
        scopes: Object.freeze({ ...record.scopes }),
      }),
      id,
    });
  }
  for (const raw of failures) {
    const record = Schema.decodeUnknownSync(V2NativeIncompatibleRecord)(raw, {
      onExcessProperty: "error",
    });
    if (
      !parseV2CanonicalCandidate(record.nativeVersion) ||
      record.nativeContractDigest !== V2_NATIVE_CONTRACT_DIGEST ||
      incompatible.has(v2NativeEvidenceKey(record.nativeVersion, record.platform, record.arch))
    )
      throw new Error("V2 native incompatible evidence conflicts.");
    incompatible.set(
      v2NativeEvidenceKey(record.nativeVersion, record.platform, record.arch),
      record,
    );
  }
  return { qualified, incompatible };
}

export function resolveV2NativeQualification(
  nativeVersion: string,
  compatibilityDigest: string,
  platform: string = process.platform,
  arch: string = process.arch,
) {
  return selectV2NativeQualification(
    validateV2NativeQualificationRegistry(
      V2_NATIVE_RELEASE_QUALIFICATIONS,
      V2_NATIVE_RELEASE_INCOMPATIBILITIES,
    ),
    nativeVersion,
    compatibilityDigest,
    platform,
    arch,
  );
}

/** Missing semantic evidence is informational under runtime-checks + warning. Invalid registry
 * metadata and known incompatibilities remain hard failures, never an unqualified fallback. */
export function resolveV2NativeReleaseQualification(
  nativeVersion: string,
  platform: string = process.platform,
  arch: string = process.arch,
) {
  const registry = validateV2NativeQualificationRegistry(
    V2_NATIVE_RELEASE_QUALIFICATIONS,
    V2_NATIVE_RELEASE_INCOMPATIBILITIES,
  );
  return selectV2NativeReleaseEvidence(registry, nativeVersion, platform, arch);
}

/** Retained signed modules keep their original constraints; new policy never rewrites old bytes. */
export function assertV2RuntimeBootstrap(
  nativeVersion: string,
  artifact: Pick<V2PluginSetupArtifact, "compatibility" | "compatibilityDigest">,
) {
  try {
    const candidate = parseV2CanonicalCandidate(nativeVersion);
    if (!candidate) throw new Error("Unsupported native runtime");
    const descriptor = knownV2BootstrapCompatibility(
      artifact.compatibility,
      artifact.compatibilityDigest,
    );
    if (
      descriptor.format === "bigbud.thread.compatibility.v1" &&
      !descriptor.qualifiedVersions.includes(nativeVersion)
    )
      throw new Error("Original bootstrap release guard rejected");
    if (
      artifact.compatibilityDigest === V2_N1_COMPATIBILITY_DIGEST &&
      candidate.minor === 0 &&
      candidate.patch < 26
    )
      throw new Error("Original bootstrap minimum rejected");
  } catch {
    throw new V2NativeCompatibilityError(
      "bootstrap-contract-incompatible",
      "selected bootstrap contract/original constraints do not cover this runtime; cleanup/history evidence is retained.",
      nativeVersion,
    );
  }
}

/** A release-qualified probe cannot bind an uncovered descriptor or widen N0's original guard. */
export function assertV2QualifiedBootstrap(
  record: V2NativeQualificationRecord,
  artifact: Pick<V2PluginSetupArtifact, "compatibility" | "compatibilityDigest">,
) {
  assertV2RuntimeBootstrap(record.nativeVersion, artifact);
  if (
    !record.bootstrapContractDigests.includes(artifact.compatibilityDigest) ||
    (artifact.compatibility.format === "bigbud.thread.compatibility.v1" &&
      !artifact.compatibility.qualifiedVersions.includes(record.nativeVersion))
  )
    throw new V2NativeCompatibilityError(
      "bootstrap-contract-incompatible",
      "complete native qualification/original constraints do not cover this selected bootstrap; cleanup/history evidence is retained.",
      record.nativeVersion,
    );
}

/** Evidence cannot override failed runtime compatibility; callers still establish fresh API/source proof. */
export function selectV2NativeQualification(
  registry: ReturnType<typeof validateV2NativeQualificationRegistry>,
  nativeVersion: string,
  compatibilityDigest: string,
  platform: string,
  arch: string,
) {
  const selected = selectV2NativeReleaseEvidence(registry, nativeVersion, platform, arch);
  if (!selected)
    throw new V2NativeCompatibilityError(
      "native-qualification-required",
      "Native qualification is required to claim completed semantic evidence; runtime compatibility is a separate production check.",
      nativeVersion,
    );
  if (!selected.record.bootstrapContractDigests.includes(compatibilityDigest))
    throw new V2NativeCompatibilityError(
      "bootstrap-contract-incompatible",
      "native qualification does not cover the selected bootstrap contract.",
      nativeVersion,
    );
  return selected;
}

/** Evidence lookup grants no execution authority: all API/source/bootstrap checks still run. */
export function selectV2NativeReleaseEvidence(
  registry: ReturnType<typeof validateV2NativeQualificationRegistry>,
  nativeVersion: string,
  platform: string = process.platform,
  arch: string = process.arch,
) {
  v2NativeRuntimePlatform(platform, arch);
  if (!parseV2CanonicalCandidate(nativeVersion))
    throw new V2NativeCompatibilityError(
      "native-version-unsupported",
      "canonical tools require a stable V2 candidate with compatible APIs and bridge capabilities; models are checked separately.",
      nativeVersion,
    );
  const key = v2NativeEvidenceKey(nativeVersion, platform, arch);
  if (registry.incompatible.has(key))
    throw new V2NativeCompatibilityError(
      "native-qualification-incompatible",
      "native semantic qualification recorded an incompatibility; canonical execution is blocked.",
      nativeVersion,
    );
  return registry.qualified.get(key);
}

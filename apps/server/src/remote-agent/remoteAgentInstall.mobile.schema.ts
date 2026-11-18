import {
  MobileGatewayDesiredSelection,
  validateMobileGatewaySelections,
} from "./mobileGatewayActivation.selection.schema.ts";
import {
  MobileGatewayController,
  MobileGatewayControllerHost,
  MobileGatewayLifecycle,
  validateMobileGatewayLifecycle,
} from "./mobileGatewayLifecycle.schema.ts";
import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { MobileOptionalArtifact } from "@bigbud/contracts/server/mobileOptionalArtifact";
import {
  RemoteBackendAuthority,
  RemoteBackendInstallationFingerprint,
} from "@bigbud/contracts/server/remoteBackendHandshake";
import {
  canonicalizeMobileOptionalArtifact,
  parseMobileOptionalArtifact,
} from "@bigbud/shared/mobileOptionalArtifact";
import {
  MobilePublicationIntent,
  MobilePublicationReceipt,
} from "./mobileOptionalPublication.schema.ts";

const Counter = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Token = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,128}$/));
export const MAX_MOBILE_REGISTRY_RELEASES = 8;
export const MAX_MOBILE_REGISTRY_STAGES = 16;
export const MobileRegistryOwnerSchema = Schema.Struct({
  authority: RemoteBackendAuthority,
  installationFingerprint: RemoteBackendInstallationFingerprint,
});
export type MobileRegistryOwner = typeof MobileRegistryOwnerSchema.Type;
export const MobileRegistryControllerSchema = Schema.Struct({
  ...MobileGatewayController.fields,
});
export type MobileRegistryController = typeof MobileRegistryControllerSchema.Type;
const ReleaseId = Schema.String.check(Schema.isPattern(/^mobile-release:[a-f0-9]{64}$/));
export const MobileRegistryReleaseSchema = Schema.Struct({
  id: ReleaseId,
  gateway: MobileOptionalArtifact,
  assets: MobileOptionalArtifact,
});
export type MobileRegistryRelease = typeof MobileRegistryReleaseSchema.Type;
/**
 * Monotonic tally of settled history retired from the bounded journal (`mobileStageRetirement`).
 * `revisionFloor` is the highest consent revision of any retired stage: a new stage must be newer,
 * so a retired (id, revision) replay fence can never be re-admitted. The counters keep the
 * selection-revision and attempt-kind sequences continuous after their prefixes leave.
 */
export const MobileRegistryRetiredSchema = Schema.Struct({
  stages: Counter,
  revisionFloor: Counter,
  selections: Counter,
  attempts: Counter,
});
export type MobileRegistryRetired = typeof MobileRegistryRetiredSchema.Type;
export const NO_MOBILE_REGISTRY_RETIREMENT: MobileRegistryRetired = Object.freeze({
  stages: 0,
  revisionFloor: 0,
  selections: 0,
  attempts: 0,
});
export const MobileRegistrySchema = Schema.Struct({
  owner: MobileRegistryOwnerSchema,
  consent: Schema.Struct({
    revision: Counter.check(Schema.isGreaterThanOrEqualTo(1)),
    enabled: Schema.Boolean,
  }),
  releases: Schema.Array(MobileRegistryReleaseSchema),
  gatewayLifecycle: Schema.optional(MobileGatewayLifecycle),
  desired: Schema.optional(MobileGatewayDesiredSelection),
  desiredHistory: Schema.optional(Schema.Array(MobileGatewayDesiredSelection)),
  retired: Schema.optional(MobileRegistryRetiredSchema),
  stages: Schema.Array(
    Schema.Struct({
      id: Token,
      releaseId: ReleaseId,
      consentRevision: Counter.check(Schema.isGreaterThanOrEqualTo(1)),
      controller: MobileRegistryControllerSchema,
      controllerHost: Schema.optional(MobileGatewayControllerHost),
      phase: Schema.Literals([
        "reserved",
        "artifact-bytes-verified",
        "publication-writing",
        "files-published",
        "cancelled",
      ]),
      publicationIntent: Schema.optional(MobilePublicationIntent),
      publicationReceipt: Schema.optional(MobilePublicationReceipt),
    }),
  ),
});
export type MobileRegistry = typeof MobileRegistrySchema.Type;

export function mobileRegistryOwnerEqual(a: MobileRegistryOwner, b: MobileRegistryOwner): boolean {
  return (
    a.authority.authorityId === b.authority.authorityId &&
    a.authority.keyFingerprint === b.authority.keyFingerprint &&
    a.authority.keyEpoch === b.authority.keyEpoch &&
    a.installationFingerprint === b.installationFingerprint
  );
}

export function mobileRegistryReleaseId(
  gateway: MobileOptionalArtifact,
  assets: MobileOptionalArtifact,
): string {
  return (
    "mobile-release:" +
    createHash("sha256")
      .update("bigbud.mobile-component-release.v1\0")
      .update(
        JSON.stringify([
          canonicalizeMobileOptionalArtifact(gateway),
          gateway.signature.value,
          canonicalizeMobileOptionalArtifact(assets),
          assets.signature.value,
        ]),
      )
      .digest("hex")
  );
}

/** Strict structural validation is not signature admission; transitions must reverify trust. */
export function validateMobileRegistry(mobile: MobileRegistry): void {
  if (!Number.isSafeInteger(mobile.owner.authority.keyEpoch))
    throw new Error("Invalid mobile authority key epoch.");
  if (
    mobile.releases.length > MAX_MOBILE_REGISTRY_RELEASES ||
    mobile.stages.length > MAX_MOBILE_REGISTRY_STAGES
  ) {
    throw new Error("Mobile registry record budget exceeded.");
  }
  const retired = mobile.retired ?? NO_MOBILE_REGISTRY_RETIREMENT;
  // Only superseded consent revisions retire, so the floor stays below the current revision.
  if (
    retired.revisionFloor >= mobile.consent.revision ||
    (retired.stages === 0) !== (retired.revisionFloor === 0)
  )
    throw new Error("Invalid mobile retirement tally.");
  if (mobile.gatewayLifecycle)
    validateMobileGatewayLifecycle(mobile.gatewayLifecycle, retired.attempts);
  validateMobileGatewaySelections(mobile);
  const releases = new Set<string>();
  for (const release of mobile.releases) {
    const gateway = parseMobileOptionalArtifact(release.gateway);
    const assets = parseMobileOptionalArtifact(release.assets);
    if (
      gateway.kind !== "mobile-gateway" ||
      assets.kind !== "mobile-assets" ||
      release.id !== mobileRegistryReleaseId(gateway, assets) ||
      releases.has(release.id) ||
      JSON.stringify(gateway.compatibility) !== JSON.stringify(assets.compatibility)
    ) {
      throw new Error("Invalid or duplicate mobile release tuple.");
    }
    releases.add(release.id);
  }
  for (const attempt of mobile.gatewayLifecycle?.attempts ?? []) {
    if (!attempt.nativeOwnership) continue;
    const original = attempt.nativeOwnership,
      binding = original.binding;
    const release = mobile.releases.find((r) => r.id === attempt.releaseId);
    const stage = mobile.stages.find((entry) => entry.id === attempt.stageId);
    if (
      !release ||
      !stage ||
      stage.releaseId !== attempt.releaseId ||
      stage.consentRevision !== attempt.consentRevision ||
      !stage.publicationReceipt ||
      binding.authority !== mobile.owner.authority.authorityId ||
      binding.installation !== mobile.owner.installationFingerprint ||
      binding.executableSha256 !== release.gateway.sha256 ||
      binding.assetsSha256 !== release.assets.sha256
    )
      throw Error("Native original execution must retain its exact authority/publication history.");
  }
  const stages = new Set<string>();
  for (const stage of mobile.stages) {
    if (
      (stage.phase === "publication-writing" &&
        (!stage.publicationIntent || stage.publicationReceipt)) ||
      (stage.phase === "files-published" &&
        (!stage.publicationIntent || !stage.publicationReceipt)) ||
      (stage.publicationReceipt && !stage.publicationIntent) ||
      (["reserved", "artifact-bytes-verified"].includes(stage.phase) &&
        (stage.publicationIntent || stage.publicationReceipt))
    ) {
      throw new Error("Invalid mobile file publication journal.");
    }
    if (
      stages.has(stage.id) ||
      !releases.has(stage.releaseId) ||
      stage.consentRevision > mobile.consent.revision ||
      (stage.phase !== "cancelled" &&
        (!mobile.consent.enabled || stage.consentRevision !== mobile.consent.revision))
    ) {
      throw new Error("Invalid mobile stage or stale consent claim.");
    }
    stages.add(stage.id);
  }
}

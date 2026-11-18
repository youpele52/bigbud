import { compareProcessStartToken } from "@bigbud/shared/processStartToken";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  verifyMobileOptionalArtifactSignature,
  assertMobileOptionalArtifactCompatibility,
} from "@bigbud/shared/mobileOptionalArtifact";
import { extractMobileOptionalAssets } from "./mobileOptionalAssets.ts";
import {
  assertMobilePublicationAuthority,
  type MobilePublicationAuthority,
} from "./mobileOptionalPublication.authority.ts";
import {
  inspectPublishedPair,
  privateDirectory,
  directoryIdentity,
  MOBILE_COMPONENT_NAMESPACE,
  mobilePublicationDirectoryKey,
} from "./mobileOptionalPublication.files.ts";

export async function inspectMobilePublication(
  authority: MobilePublicationAuthority,
  stageId: string,
  consentRevision: number,
  keys: Readonly<Record<string, string>>,
  signal?: AbortSignal,
  allowPriorController = false,
  retainArchive = false,
) {
  assertMobilePublicationAuthority(authority);
  const initial = await authority.registry(signal).read();
  if (initial.schemaVersion !== 3) throw new Error("Mobile publication journal is unavailable.");
  const stage = initial.mobile.stages.find((entry) => entry.id === stageId);
  const release = initial.mobile.releases.find((entry) => entry.id === stage?.releaseId);
  if (
    !stage ||
    !release ||
    !stage.publicationIntent ||
    !stage.publicationReceipt ||
    stage.phase !== "files-published" ||
    stage.consentRevision !== consentRevision
  )
    throw new Error("Mobile files have no current durable publication receipt.");
  const current = await authority.inspect(consentRevision, release.gateway, keys, signal);
  if (stage.publicationIntent.key !== mobilePublicationDirectoryKey(authority.pin, stage))
    throw new Error("Mobile publication key is not the owner-computed namespace.");
  if (
    stage.controller.id !== authority.controller.id ||
    stage.controller.pid !== authority.controller.pid ||
    stage.controller.startedAt !== authority.controller.startedAt
  ) {
    if (
      !allowPriorController ||
      !stage.controllerHost ||
      compareProcessStartToken(stage.controller.startedAt, stage.controller.startedAt) !== "same" ||
      authority.owner.classifyOwner({
        pid: stage.controller.pid,
        startedAt: stage.controller.startedAt,
        hostname: stage.controllerHost.hostname,
        machineId: stage.controllerHost.machineId,
      }) !== "dead"
    ) {
      throw new Error(
        "A live, foreign or missing-host previous publication controller requires explicit repair.",
      );
    }
  } else if (
    stage.controllerHost &&
    JSON.stringify(stage.controllerHost) !==
      JSON.stringify({ hostname: authority.owner.hostname, machineId: authority.owner.machineId })
  ) {
    throw new Error("Current publication controller host changed.");
  }
  for (const artifact of [release.gateway, release.assets]) {
    verifyMobileOptionalArtifactSignature(artifact, keys);
    assertMobileOptionalArtifactCompatibility(
      artifact,
      current.context.host,
      release.gateway.compatibility,
    );
  }
  const files = await inspectPublishedPair(
    authority.root,
    stage.publicationIntent,
    release.gateway,
    release.assets,
    retainArchive,
    signal,
  );
  if (JSON.stringify(files.receipt) !== JSON.stringify(stage.publicationReceipt))
    throw new Error("Mobile published file identities were substituted.");
  const final = await authority.registry(signal).read();
  const context = authority.context(final, consentRevision, release.gateway, keys);
  if (
    final.schemaVersion !== 3 ||
    JSON.stringify(final.mobile.stages.find((entry) => entry.id === stageId)) !==
      JSON.stringify(stage)
  ) {
    throw new Error("Mobile publication changed during verification.");
  }
  await authority.enabled();
  await authority.assertAuthority();
  assertMobilePublicationAuthority(authority);
  return { stage, release, files, context };
}

/** Probe is never a runtime assets cache or permission to execute; it is settled before cleanup. */
export async function probeMobilePublicationArchive(
  authority: MobilePublicationAuthority,
  release: Awaited<ReturnType<typeof inspectMobilePublication>>["release"],
  context: Awaited<ReturnType<typeof inspectMobilePublication>>["context"],
  key: string,
  bytes: Buffer,
  signal: AbortSignal,
) {
  assertMobilePublicationAuthority(authority);
  await authority.inspect(
    context.expectedConsentRevision,
    release.gateway,
    context.trustedKeys,
    signal,
  );
  const parent = join(authority.root, MOBILE_COMPONENT_NAMESPACE);
  const before = directoryIdentity(await privateDirectory(parent));
  const destination = join(parent, `probe-${key}-${randomBytes(8).toString("hex")}`);
  const extracted = await extractMobileOptionalAssets({
    mobileConsent: true,
    artifact: release.assets,
    bytes,
    trustedKeys: context.trustedKeys,
    host: context.host,
    release: release.gateway.compatibility,
    destination,
    signal,
  });
  if (!extracted) throw new Error("Mobile archive probe did not complete.");
  const owned = directoryIdentity(await privateDirectory(extracted));
  await authority.assertAuthority();
  if (
    JSON.stringify(before) !== JSON.stringify(directoryIdentity(await privateDirectory(parent))) ||
    JSON.stringify(owned) !== JSON.stringify(directoryIdentity(await privateDirectory(extracted)))
  ) {
    throw new Error("Mobile probe ownership changed; preserve its bytes.");
  }
  await fs.rm(extracted, { recursive: true });
  signal.throwIfAborted();
  await authority.inspect(
    context.expectedConsentRevision,
    release.gateway,
    context.trustedKeys,
    signal,
  );
}

import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  MobileOptionalArtifact,
  type MobileGatewayTarget,
  type MobileOptionalArtifactCompatibility,
} from "@bigbud/contracts/server/mobileOptionalArtifact";

import { verifyPinnedArtifactSignature } from "./artifactSignature.ts";

export const MOBILE_OPTIONAL_ARTIFACT_DOMAIN = "bigbud.mobile-optional-artifact.v1\0";

export function parseMobileOptionalArtifact(value: unknown): MobileOptionalArtifact {
  const artifact = Schema.decodeUnknownSync(MobileOptionalArtifact)(value, {
    onExcessProperty: "error",
  });
  const url = new URL(artifact.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.href !== artifact.url
  ) {
    throw new Error(
      "Mobile artifact source must be canonical HTTPS without credentials or fragment.",
    );
  }
  if (
    artifact.compatibility.minimumMobileRpcRevision >
    artifact.compatibility.maximumMobileRpcRevision
  ) {
    throw new Error("Mobile artifact RPC compatibility range is inverted.");
  }
  return artifact;
}

/** Explicit field order, domain and schema version are part of the signing protocol. */
export function canonicalizeMobileOptionalArtifact(artifact: MobileOptionalArtifact): string {
  const compatible = artifact.compatibility;
  return (
    MOBILE_OPTIONAL_ARTIFACT_DOMAIN +
    JSON.stringify({
      schemaVersion: artifact.schemaVersion,
      kind: artifact.kind,
      format: artifact.format,
      targetTriple: artifact.targetTriple,
      compatibility: {
        agentVersion: compatible.agentVersion,
        backendVersion: compatible.backendVersion,
        gatewayVersion: compatible.gatewayVersion,
        mobileAssetVersion: compatible.mobileAssetVersion,
        minimumMobileRpcRevision: compatible.minimumMobileRpcRevision,
        maximumMobileRpcRevision: compatible.maximumMobileRpcRevision,
      },
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      url: artifact.url,
      signatureAlgorithm: artifact.signature.algorithm,
      signatureKeyId: artifact.signature.keyId,
    })
  );
}

export function verifyMobileOptionalArtifactSignature(
  artifact: MobileOptionalArtifact,
  trustedKeys: Readonly<Record<string, string>>,
): void {
  const publicKey = Object.hasOwn(trustedKeys, artifact.signature.keyId)
    ? trustedKeys[artifact.signature.keyId]
    : undefined;
  if (
    !publicKey ||
    !verifyPinnedArtifactSignature({
      payload: Buffer.from(canonicalizeMobileOptionalArtifact(artifact)),
      publicKey,
      signature: artifact.signature.value,
      strictEd25519: true,
    })
  ) {
    throw new Error("Mobile optional artifact signature verification failed.");
  }
}

export interface MobileOptionalArtifactHost {
  readonly targetTriple: MobileGatewayTarget;
  readonly agentVersion: string;
  readonly backendVersion: string;
  readonly mobileRpcRevision: number;
}

export function assertMobileOptionalArtifactCompatibility(
  artifact: MobileOptionalArtifact,
  host: MobileOptionalArtifactHost,
  release: Pick<MobileOptionalArtifactCompatibility, "gatewayVersion" | "mobileAssetVersion">,
): void {
  const compatible = artifact.compatibility;
  if (
    (artifact.kind === "mobile-gateway" && artifact.targetTriple !== host.targetTriple) ||
    compatible.agentVersion !== host.agentVersion ||
    compatible.backendVersion !== host.backendVersion ||
    compatible.gatewayVersion !== release.gatewayVersion ||
    compatible.mobileAssetVersion !== release.mobileAssetVersion ||
    !Number.isSafeInteger(host.mobileRpcRevision) ||
    host.mobileRpcRevision < compatible.minimumMobileRpcRevision ||
    host.mobileRpcRevision > compatible.maximumMobileRpcRevision
  ) {
    throw new Error("Mobile optional artifact is incompatible with the selected host/release.");
  }
}

export function verifyMobileOptionalArtifactBytes(
  artifact: MobileOptionalArtifact,
  bytes: Uint8Array,
): void {
  if (
    bytes.byteLength !== artifact.sizeBytes ||
    createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
  ) {
    throw new Error("Mobile optional artifact size or SHA-256 verification failed.");
  }
}

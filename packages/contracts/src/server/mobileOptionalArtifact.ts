import { Schema } from "effect";

import { PositiveInt } from "../core/baseSchemas";

const Version = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const BoundedPositiveInt = PositiveInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));

/** Exact release tuple. A producer publishes both components for this same tuple. */
export const MobileOptionalArtifactCompatibility = Schema.Struct({
  agentVersion: Version,
  backendVersion: Version,
  gatewayVersion: Version,
  mobileAssetVersion: Version,
  minimumMobileRpcRevision: BoundedPositiveInt,
  maximumMobileRpcRevision: BoundedPositiveInt,
});
export type MobileOptionalArtifactCompatibility = typeof MobileOptionalArtifactCompatibility.Type;

export const MobileGatewayTarget = Schema.Literals([
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
]);
export type MobileGatewayTarget = typeof MobileGatewayTarget.Type;

const fields = {
  schemaVersion: Schema.Literal(1),
  compatibility: MobileOptionalArtifactCompatibility,
  sizeBytes: BoundedPositiveInt.check(Schema.isLessThanOrEqualTo(128 * 1024 * 1024)),
  sha256: Sha256,
  /** HTTPS only is enforced by the runtime before any fetch; no credentials or fragment. */
  url: Schema.String.check(Schema.isMaxLength(4096)),
  signature: Schema.Struct({
    algorithm: Schema.Literal("ed25519"),
    keyId: Version,
    value: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/]{86}==$/)),
  }),
};

/** Sidecars remain distinct from the Rust base-agent artifact and its hello/build identity. */
export const MobileOptionalArtifact = Schema.Union([
  Schema.Struct({
    ...fields,
    kind: Schema.Literal("mobile-gateway"),
    format: Schema.Literal("executable"),
    targetTriple: MobileGatewayTarget,
  }),
  Schema.Struct({
    ...fields,
    kind: Schema.Literal("mobile-assets"),
    format: Schema.Literal("tar.gz"),
    targetTriple: Schema.Literal("portable"),
  }),
]);
export type MobileOptionalArtifact = typeof MobileOptionalArtifact.Type;

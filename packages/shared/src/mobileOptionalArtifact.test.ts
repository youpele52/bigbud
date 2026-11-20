import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MobileOptionalArtifact } from "@bigbud/contracts/server/mobileOptionalArtifact";

import {
  assertMobileOptionalArtifactCompatibility,
  canonicalizeMobileOptionalArtifact,
  parseMobileOptionalArtifact,
  verifyMobileOptionalArtifactBytes,
  verifyMobileOptionalArtifactSignature,
} from "./mobileOptionalArtifact.ts";

const keys = generateKeyPairSync("ed25519");
const trust = { release: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
const bytes = Buffer.from("gateway fixture");
const artifact: MobileOptionalArtifact = {
  schemaVersion: 1,
  kind: "mobile-gateway",
  format: "executable",
  targetTriple: "aarch64-unknown-linux-musl",
  compatibility: {
    agentVersion: "1.0.0",
    backendVersion: "2.0.0",
    gatewayVersion: "3.0.0",
    mobileAssetVersion: "4.0.0",
    minimumMobileRpcRevision: 1,
    maximumMobileRpcRevision: 2,
  },
  sizeBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  url: "https://releases.example/gateway",
  signature: { algorithm: "ed25519", keyId: "release", value: "" },
};
const signed = {
  ...artifact,
  signature: {
    ...artifact.signature,
    value: sign(
      null,
      Buffer.from(canonicalizeMobileOptionalArtifact(artifact)),
      keys.privateKey,
    ).toString("base64"),
  },
};
const host = {
  targetTriple: "aarch64-unknown-linux-musl" as const,
  agentVersion: "1.0.0",
  backendVersion: "2.0.0",
  mobileRpcRevision: 1,
};

describe("optional mobile artifact trust", () => {
  it("round trips strict metadata and verifies signed bytes and compatible host", () => {
    const decoded = parseMobileOptionalArtifact(signed);
    expect(decoded).not.toBe(signed);
    expect(decoded.compatibility).not.toBe(signed.compatibility);
    verifyMobileOptionalArtifactSignature(decoded, trust);
    verifyMobileOptionalArtifactBytes(decoded, bytes);
    assertMobileOptionalArtifactCompatibility(decoded, host, decoded.compatibility);
    expect(
      canonicalizeMobileOptionalArtifact(decoded).startsWith(
        "bigbud.mobile-optional-artifact.v1\0",
      ),
    ).toBe(true);
  });

  it.each([
    { url: "https://releases.example/other" },
    { sizeBytes: bytes.byteLength + 1 },
    { sha256: "a".repeat(64) },
    { targetTriple: "x86_64-unknown-linux-musl" },
    { kind: "mobile-assets", format: "tar.gz", targetTriple: "portable" },
    { compatibility: { ...artifact.compatibility, backendVersion: "9.0.0" } },
    { compatibility: { ...artifact.compatibility, minimumMobileRpcRevision: 2 } },
  ])("rejects signed metadata substitution %j", (patch) => {
    const changed = parseMobileOptionalArtifact({ ...signed, ...patch });
    expect(() => verifyMobileOptionalArtifactSignature(changed, trust)).toThrow(/signature/);
  });

  it("rejects unknown keys, inherited keys and noncanonical signature encodings", () => {
    expect(() => verifyMobileOptionalArtifactSignature(signed, {})).toThrow(/signature/);
    expect(() => verifyMobileOptionalArtifactSignature(signed, Object.create(trust))).toThrow(
      /signature/,
    );
    expect(() =>
      verifyMobileOptionalArtifactSignature(
        {
          ...signed,
          signature: { ...signed.signature, value: signed.signature.value + "\n" },
        },
        trust,
      ),
    ).toThrow(/signature/);
  });

  it.each([
    { url: "http://releases.example/a" },
    { url: "https://user:secret@releases.example/a" },
    { url: "https://releases.example/a#other" },
    { url: "https://RELEASES.example/a" },
    { sizeBytes: 128 * 1024 * 1024 + 1 },
    { sizeBytes: Number.POSITIVE_INFINITY },
    { extra: "ignored fields must fail" },
    { format: "tar.gz" },
    { compatibility: { ...artifact.compatibility, maximumMobileRpcRevision: 0 } },
    { compatibility: { ...artifact.compatibility, minimumMobileRpcRevision: 3 } },
  ])("rejects invalid metadata before IO %j", (patch) => {
    expect(() => parseMobileOptionalArtifact({ ...signed, ...patch })).toThrow();
  });

  it.each([
    { backendVersion: "old" },
    { agentVersion: "old" },
    { targetTriple: "x86_64-unknown-linux-musl" as const },
    { mobileRpcRevision: 0 },
    { mobileRpcRevision: 3 },
    { mobileRpcRevision: Number.NaN },
  ])("fails incompatible host %j", (patch) => {
    expect(() =>
      assertMobileOptionalArtifactCompatibility(
        signed,
        { ...host, ...patch },
        signed.compatibility,
      ),
    ).toThrow(/incompatible/);
  });

  it("refuses truncated or corrupted component bytes", () => {
    expect(() => verifyMobileOptionalArtifactBytes(signed, bytes.subarray(1))).toThrow(/SHA-256/);
    expect(() => verifyMobileOptionalArtifactBytes(signed, Buffer.alloc(bytes.length))).toThrow(
      /SHA-256/,
    );
  });
});

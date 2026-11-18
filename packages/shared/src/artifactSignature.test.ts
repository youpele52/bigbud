import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { verifyPinnedArtifactSignature } from "./artifactSignature.ts";

it("verifies the exact payload against the caller's pinned Ed25519 key", () => {
  const keys = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const payload = Buffer.from("bigbud.test.domain.v1\0manifest");
  const signature = sign(null, payload, keys.privateKey).toString("base64");
  const input = {
    payload,
    signature,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    strictEd25519: true,
  };
  expect(verifyPinnedArtifactSignature(input)).toBe(true);
  expect(
    verifyPinnedArtifactSignature({ ...input, payload: Buffer.from("other.domain\0manifest") }),
  ).toBe(false);
  expect(
    verifyPinnedArtifactSignature({
      ...input,
      publicKey: other.publicKey.export({ type: "spki", format: "pem" }).toString(),
    }),
  ).toBe(false);
});
it("strict mode refuses noncanonical signatures and malformed keys without throwing", () => {
  const keys = generateKeyPairSync("ed25519");
  const payload = Buffer.from("payload");
  const signature = sign(null, payload, keys.privateKey).toString("base64");
  const input = {
    payload,
    signature,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    strictEd25519: true,
  };
  expect(verifyPinnedArtifactSignature({ ...input, signature: `${signature}\n` })).toBe(false);
  expect(verifyPinnedArtifactSignature({ ...input, signature: "" })).toBe(false);
  expect(verifyPinnedArtifactSignature({ ...input, publicKey: "invalid" })).toBe(false);
  // The existing P4 wrapper deliberately retains Node's legacy decoding semantics.
  expect(
    verifyPinnedArtifactSignature({ ...input, strictEd25519: false, signature: `${signature}\n` }),
  ).toBe(true);
});

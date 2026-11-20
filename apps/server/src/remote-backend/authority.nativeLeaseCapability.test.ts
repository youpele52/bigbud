import { keyFingerprint } from "./authority.record.ts";
import { createPrivateKey, createSecretKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { expect, it } from "vitest";
import {
  makeNativeLeaseCapabilityDerivation,
  assertNativeLeaseCapabilityDerivation,
  NATIVE_LEASE_CAPABILITY_DOMAIN,
} from "./authority.nativeLeaseCapability.ts";

it("re-derives the same private capability after loading the same identity without a persisted secret", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const context = Buffer.from("canonical-original-owner-binding-receipt");
  const capability = makeNativeLeaseCapabilityDerivation(privateKey)(context);
  const loaded = createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" }));
  expect(makeNativeLeaseCapabilityDerivation(loaded)(Uint8Array.from(context))).toEqual(capability);
  expect(capability.length).toBe(64);
  expect(
    verify(
      null,
      Buffer.concat([Buffer.from(NATIVE_LEASE_CAPABILITY_DOMAIN), context]),
      publicKey,
      capability,
    ),
  ).toBe(true);
  expect(
    makeNativeLeaseCapabilityDerivation(loaded)(Buffer.from("different-original-context")),
  ).not.toEqual(capability);
});
it("cannot be recovered through the public arbitrary challenge signing domain", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const context = Buffer.from("lease-purpose-and-original-tuple");
  const capability = makeNativeLeaseCapabilityDerivation(privateKey)(context);
  // Even a public request containing the exact private payload has the additional public prefix.
  const publicChallenge = Buffer.concat([Buffer.from(NATIVE_LEASE_CAPABILITY_DOMAIN), context]);
  const publicSignature = sign(
    null,
    Buffer.concat([Buffer.from("bigbud.remote-backend.challenge.v1\0"), publicChallenge]),
    privateKey,
  );
  expect(publicSignature).not.toEqual(Buffer.from(capability));
  expect(verify(null, publicChallenge, publicKey, publicSignature)).toBe(false);
  capability.fill(0);
  expect(makeNativeLeaseCapabilityDerivation(privateKey)(context)).not.toEqual(capability);
});
it("refuses public/symmetric keys and unbounded contexts before signing", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  expect(() => makeNativeLeaseCapabilityDerivation(publicKey)).toThrow(/private Ed25519/);
  expect(() => makeNativeLeaseCapabilityDerivation(createSecretKey(Buffer.alloc(32)))).toThrow(
    /private Ed25519/,
  );
  const derive = makeNativeLeaseCapabilityDerivation(privateKey);
  expect(() => derive(new Uint8Array())).toThrow(/context size/);
  expect(() => derive(new Uint8Array(4097))).toThrow(/context size/);
});

it("binds the original private function to the actual authority key and refuses public/wrapped substitutes", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const derive = makeNativeLeaseCapabilityDerivation(privateKey);
  expect(() =>
    assertNativeLeaseCapabilityDerivation(derive, keyFingerprint(publicKey)),
  ).not.toThrow();
  for (const fake of [() => new Uint8Array(64), derive.bind(undefined), new Proxy(derive, {}), {}])
    expect(() => assertNativeLeaseCapabilityDerivation(fake, keyFingerprint(publicKey))).toThrow(
      /Original private native signer/,
    );
  const foreign = generateKeyPairSync("ed25519").publicKey;
  expect(() => assertNativeLeaseCapabilityDerivation(derive, keyFingerprint(foreign))).toThrow(
    /held identity/,
  );
});

import { createPublicKey } from "node:crypto";

/**
 * Release signing public keys this build of bigbud trusts for artifacts downloaded from the
 * default GitHub release location. The private half lives only in the release secrets.
 *
 * Rotation order: (1) add the new key here and ship an app release that carries it, (2) only then
 * switch the `BIGBUD_REMOTE_AGENT_SIGNING_KEY{,_ID}` secrets, (3) drop the old key once clients
 * that predate the rotation no longer need to verify it. The release verifier refuses to publish
 * a manifest signed with a key that is not listed here.
 */
export const PINNED_RELEASE_TRUST_STORE: Readonly<Record<string, string>> = Object.freeze({
  "release-2026": [
    "-----BEGIN PUBLIC KEY-----",
    "MCowBQYDK2VwAyEA93yS6th8NJik3khUKf1Z4HKV+5i1Iv7xlaPXpXhQSTs=",
    "-----END PUBLIC KEY-----",
    "",
  ].join("\n"),
});

export class ReleaseTrustError extends Error {
  override readonly name = "ReleaseTrustError";
}

/** Normalized Ed25519 SPKI DER bytes, or undefined when the value is not an Ed25519 public key. */
export function releasePublicKeyDer(pem: unknown): Buffer | undefined {
  if (typeof pem !== "string" || pem.length > 4096) return undefined;
  try {
    const key = createPublicKey(pem.trim());
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") return undefined;
    return key.export({ type: "spki", format: "der" });
  } catch {
    return undefined;
  }
}

/**
 * Keep only downloaded trust entries whose key id is pinned AND whose key material equals the
 * pinned key. Comparison is by SPKI DER bytes, so PEM wrapping/line-ending differences are
 * accepted while a different key under a pinned id is dropped. Returned values are the pinned PEMs.
 */
export function pinReleaseTrustStore(
  downloaded: Readonly<Record<string, unknown>>,
  pinned: Readonly<Record<string, string>> = PINNED_RELEASE_TRUST_STORE,
): Readonly<Record<string, string>> {
  const trusted: Record<string, string> = {};
  for (const [keyId, value] of Object.entries(downloaded)) {
    if (!Object.hasOwn(pinned, keyId)) continue;
    const expected = releasePublicKeyDer(pinned[keyId]);
    const actual = releasePublicKeyDer(value);
    if (expected && actual && expected.equals(actual)) trusted[keyId] = pinned[keyId]!;
  }
  return Object.freeze(trusted);
}

export function untrustedReleaseKeyMessage(keyId: string): string {
  return `Release manifest is signed by key '${keyId}', which this version of bigbud does not trust; update bigbud.`;
}

/** Pin a downloaded trust store and require every signing key id the manifest uses to survive. */
export function requirePinnedReleaseTrust(
  downloaded: Readonly<Record<string, unknown>>,
  requiredKeyIds: Iterable<string>,
  pinned: Readonly<Record<string, string>> = PINNED_RELEASE_TRUST_STORE,
): Readonly<Record<string, string>> {
  const trusted = pinReleaseTrustStore(downloaded, pinned);
  for (const keyId of requiredKeyIds) {
    if (!Object.hasOwn(trusted, keyId))
      throw new ReleaseTrustError(untrustedReleaseKeyMessage(keyId));
  }
  return trusted;
}

/** Release-side guard: the signing key must already be pinned in shipped clients. */
export function assertPinnedReleaseSigningKey(
  input: { readonly keyId: string; readonly publicKeyPem: string },
  pinned: Readonly<Record<string, string>> = PINNED_RELEASE_TRUST_STORE,
): void {
  if (
    !Object.hasOwn(pinReleaseTrustStore({ [input.keyId]: input.publicKeyPem }, pinned), input.keyId)
  )
    throw new ReleaseTrustError(
      `Release signing key '${input.keyId}' is not pinned in packages/shared/src/releaseTrust.ts; ` +
        "clients would reject this release. Ship an app release that pins the key before switching the signing secret.",
    );
}

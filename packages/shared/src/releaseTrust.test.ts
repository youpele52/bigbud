import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assertPinnedReleaseSigningKey,
  PINNED_RELEASE_TRUST_STORE,
  pinReleaseTrustStore,
  ReleaseTrustError,
  requirePinnedReleaseTrust,
} from "./releaseTrust.ts";

const PINNED = PINNED_RELEASE_TRUST_STORE["release-2026"]!;
const otherKey = () =>
  generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

describe("pinned release trust", () => {
  it("pins the published release-2026 Ed25519 key", () => {
    const key = createPublicKey(PINNED);
    expect(key.asymmetricKeyType).toBe("ed25519");
    expect(Object.keys(PINNED_RELEASE_TRUST_STORE)).toEqual(["release-2026"]);
  });

  it("keeps a matching entry and returns the pinned PEM", () => {
    expect(pinReleaseTrustStore({ "release-2026": PINNED })).toEqual({ "release-2026": PINNED });
  });

  it.each([
    ["CRLF line endings", PINNED.replaceAll("\n", "\r\n")],
    ["no trailing newline", PINNED.trimEnd()],
    ["surrounding whitespace", `\n  ${PINNED}\n\n`],
    ["re-exported PEM", createPublicKey(PINNED).export({ type: "spki", format: "pem" }).toString()],
  ])("accepts the pinned key with %s", (_label, pem) => {
    expect(pinReleaseTrustStore({ "release-2026": pem })).toEqual({ "release-2026": PINNED });
  });

  it("drops a different key published under the pinned id", () => {
    expect(pinReleaseTrustStore({ "release-2026": otherKey() })).toEqual({});
    expect(() =>
      requirePinnedReleaseTrust({ "release-2026": otherKey() }, ["release-2026"]),
    ).toThrow(
      "Release manifest is signed by key 'release-2026', which this version of bigbud does not trust; update bigbud.",
    );
  });

  it("drops unpinned key ids even when they carry the pinned key material", () => {
    const downloaded = {
      "attacker-2026": otherKey(),
      "alias-2026": PINNED,
      "release-2026": PINNED,
    };
    expect(pinReleaseTrustStore(downloaded)).toEqual({ "release-2026": PINNED });
    expect(() => requirePinnedReleaseTrust(downloaded, ["attacker-2026"])).toThrow(
      ReleaseTrustError,
    );
  });

  it("drops malformed and non-Ed25519 values without throwing", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    for (const value of [rsa, "public-key", 42, null, PINNED.replace("93yS", "93yT")])
      expect(pinReleaseTrustStore({ "release-2026": value })).toEqual({});
  });

  it("guards release signing keys against the pinned set", () => {
    expect(() =>
      assertPinnedReleaseSigningKey({ keyId: "release-2026", publicKeyPem: PINNED }),
    ).not.toThrow();
    expect(() =>
      assertPinnedReleaseSigningKey({ keyId: "release-2026", publicKeyPem: otherKey() }),
    ).toThrow("is not pinned");
    expect(() =>
      assertPinnedReleaseSigningKey({ keyId: "release-2027", publicKeyPem: PINNED }),
    ).toThrow("Ship an app release that pins the key");
  });
});

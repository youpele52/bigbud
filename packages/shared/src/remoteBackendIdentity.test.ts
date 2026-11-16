import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";
import { describe, expect, it } from "vitest";

import {
  compareRemoteBackendMobileIdentity,
  supportsRemoteBackendMobileRevision,
  type RemoteBackendIdentityPin,
} from "./remoteBackendIdentity";

const support = { minimumMobileRpcRevision: 2, maximumMobileRpcRevision: 4 };
const descriptor: RemoteBackendMobileDescriptor = {
  handshakeRevision: 1,
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 2,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  backendVersion: "0.1.0",
  mobileRpcRevision: 3,
  mobileCapable: false,
};
const pin: RemoteBackendIdentityPin = {
  authority: { ...descriptor.authority },
  installationFingerprint: descriptor.installationFingerprint,
};

describe("remote backend mobile identity", () => {
  it("treats an unpinned origin as first-seen, never as an accepted match", () => {
    expect(compareRemoteBackendMobileIdentity(descriptor, null, support)).toBe("first-seen");
    const future = { ...descriptor, handshakeRevision: 2 };
    expect(compareRemoteBackendMobileIdentity(future, null, support)).toBe("first-seen");
    expect(supportsRemoteBackendMobileRevision(future, support)).toBe(false);
  });

  it("rejects an unsupported revision before reading identity fields", () => {
    const future = {
      ...descriptor,
      handshakeRevision: 2,
      get authority(): RemoteBackendMobileDescriptor["authority"] {
        throw new Error("newer descriptor identity must not be interpreted");
      },
    };
    expect(compareRemoteBackendMobileIdentity(future, pin, support)).toBe("unsupported-revision");
  });

  it("checks authority before installation and keys without merging identities", () => {
    const changed = {
      ...descriptor,
      authority: { ...descriptor.authority, authorityId: "d".repeat(32), keyEpoch: 9 },
      installationFingerprint: `sha256:${"e".repeat(64)}`,
    };
    expect(compareRemoteBackendMobileIdentity(changed, pin, support)).toBe("authority-changed");
    expect(
      compareRemoteBackendMobileIdentity(
        { ...changed, authority: { ...changed.authority, authorityId: pin.authority.authorityId } },
        pin,
        support,
      ),
    ).toBe("duplicate-authority");
  });

  it.each([
    [3, "f", "key-rotated"],
    [2, "f", "key-mismatch"],
    [1, "f", "key-mismatch"],
    [3, "b", "key-mismatch"],
    [1, "b", "key-mismatch"],
    [2, "b", "match"],
  ] as const)("compares key epoch %i and fingerprint %s as %s", (keyEpoch, key, verdict) => {
    const changed = {
      ...descriptor,
      authority: { ...descriptor.authority, keyEpoch, keyFingerprint: `sha256:${key.repeat(64)}` },
    };
    expect(compareRemoteBackendMobileIdentity(changed, pin, support)).toBe(verdict);
  });

  it("ignores version and mobile capability for identity, without changing the pin", () => {
    const original = structuredClone(pin);
    for (const mobileCapable of [true, false]) {
      expect(
        compareRemoteBackendMobileIdentity(
          { ...descriptor, backendVersion: "9.0.0", mobileCapable },
          pin,
          support,
        ),
      ).toBe("match");
    }
    expect(pin).toEqual(original);
  });

  it.each([
    [1, false],
    [2, true],
    [3, true],
    [4, true],
    [5, false],
    [2.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
  ])(
    "checks mobile RPC revision %s against both supported bounds",
    (mobileRpcRevision, expected) => {
      const changed = { ...descriptor, mobileRpcRevision };
      expect(supportsRemoteBackendMobileRevision(changed, support)).toBe(expected);
      expect(compareRemoteBackendMobileIdentity(changed, pin, support)).toBe(
        expected ? "match" : "unsupported-revision",
      );
    },
  );

  it.each([
    [0, 4],
    [3, 2],
    [1.5, 4],
    [2, Number.POSITIVE_INFINITY],
    [2, Number.MAX_SAFE_INTEGER + 1],
  ])("fails closed for invalid revision support %s..%s", (minimum, maximum) => {
    expect(
      supportsRemoteBackendMobileRevision(descriptor, {
        minimumMobileRpcRevision: minimum,
        maximumMobileRpcRevision: maximum,
      }),
    ).toBe(false);
  });
});

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  REMOTE_BACKEND_HANDSHAKE_REVISION,
  RemoteBackendIdentityVerdict,
  RemoteBackendMobileDescriptor,
} from "./remoteBackendHandshake";

const descriptor = {
  handshakeRevision: REMOTE_BACKEND_HANDSHAKE_REVISION,
  authority: {
    authorityId: "0123456789abcdef0123456789abcdef",
    keyFingerprint: `sha256:${"a".repeat(64)}`,
    keyEpoch: 1,
  },
  installationFingerprint: `sha256:${"b".repeat(64)}`,
  backendVersion: "0.4.0",
  mobileRpcRevision: 1,
  mobileCapable: true,
};
const decode = Schema.decodeUnknownSync(RemoteBackendMobileDescriptor);

describe("remote backend handshake contract", () => {
  it("round-trips the public-safe mobile descriptor", () => {
    expect(decode(descriptor)).toEqual(descriptor);
  });

  it("rejects malformed identities and non-positive revisions or epochs", () => {
    for (const authority of [
      { ...descriptor.authority, authorityId: "0123456789ABCDEF0123456789ABCDEF" },
      { ...descriptor.authority, authorityId: "short" },
      { ...descriptor.authority, keyFingerprint: "a".repeat(64) },
      { ...descriptor.authority, keyEpoch: 0 },
    ]) {
      expect(() => decode({ ...descriptor, authority })).toThrow();
    }
    for (const fingerprint of [`sha256:${"A".repeat(64)}`, "/home/u/.bigbud/key.pub"]) {
      expect(() =>
        decode({
          ...descriptor,
          authority: { ...descriptor.authority, keyFingerprint: fingerprint },
        }),
      ).toThrow();
      expect(() => decode({ ...descriptor, installationFingerprint: fingerprint })).toThrow();
    }
    expect(() => decode({ ...descriptor, installationFingerprint: "/home/u/.bigbud" })).toThrow();
    expect(() => decode({ ...descriptor, mobileRpcRevision: 0 })).toThrow();
    expect(() => decode({ ...descriptor, handshakeRevision: 0 })).toThrow();
    expect(() => decode({ ...descriptor, handshakeRevision: 1.5 })).toThrow();
  });

  it("never carries extra identity fields through decoding", () => {
    expect(
      decode({ ...descriptor, hostname: "vps-1", username: "root", statePath: "/root/.bigbud" }),
    ).toEqual(descriptor);
  });

  it("names every verdict the client may reach", () => {
    expect(RemoteBackendIdentityVerdict.literals).toEqual([
      "match",
      "first-seen",
      "key-rotated",
      "key-mismatch",
      "duplicate-authority",
      "authority-changed",
      "unsupported-revision",
    ]);
  });
});

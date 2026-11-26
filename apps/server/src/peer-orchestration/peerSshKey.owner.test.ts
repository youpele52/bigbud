import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ensureCoordinatorPeerKey,
  parsePeerPublicKey,
  PeerEnrollmentOwnerMismatchError,
  type PeerCoordinatorKeyMetadata,
} from "./peerSshKey.ts";

const PUBLIC_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function metadata(overrides: Partial<PeerCoordinatorKeyMetadata> = {}): PeerCoordinatorKeyMetadata {
  const publicKey = `ssh-ed25519 ${PUBLIC_KEY}`;
  return {
    publicKey,
    fingerprint: parsePeerPublicKey(publicKey).fingerprint,
    algorithm: "ssh-ed25519",
    profileBinding: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

/** A stand-in owner port that enforces idempotence, like the Rust owner. */
function fakeOwner(overrides: Partial<PeerCoordinatorKeyMetadata> = {}) {
  const value = metadata(overrides);
  const calls = { count: 0 };
  return {
    calls,
    value,
    async ensurePeerCoordinatorKey() {
      calls.count += 1;
      return value;
    },
  };
}

describe("ensureCoordinatorPeerKey (owner port)", () => {
  it("is idempotent and returns only public metadata", async () => {
    const owner = fakeOwner();
    const first = await ensureCoordinatorPeerKey(owner);
    const second = await ensureCoordinatorPeerKey(owner);
    expect(owner.calls.count).toBe(2);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(Object.keys(first).toSorted()).toEqual(["fingerprint", "publicKey", "publicKeyLine"]);
    expect(JSON.stringify(first)).not.toMatch(/private|passphrase|keyFile/);
    expect(first.publicKeyLine).toBe(`ssh-ed25519 ${PUBLIC_KEY} bigbud-peer`);
  });

  it("refuses a corrupted public key instead of trusting the wire", async () => {
    await expect(
      ensureCoordinatorPeerKey(fakeOwner({ publicKey: "ssh-rsa AAAA" })),
    ).rejects.toThrow(/ssh-ed25519/);
  });

  it("refuses a fingerprint that does not match the returned public key", async () => {
    await expect(
      ensureCoordinatorPeerKey(fakeOwner({ fingerprint: `sha256:${"0".repeat(64)}` })),
    ).rejects.toBeInstanceOf(PeerEnrollmentOwnerMismatchError);
  });

  it("refuses an owner reply with no profile binding", async () => {
    await expect(
      ensureCoordinatorPeerKey(fakeOwner({ profileBinding: new Uint8Array() })),
    ).rejects.toBeInstanceOf(PeerEnrollmentOwnerMismatchError);
  });

  it("launches no ssh-keygen: the source has no child-process or keygen path", () => {
    const source = readFileSync(new URL("./peerSshKey.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:child_process|execFile\(|spawn\(|from "node:child_process"/);
  });
});

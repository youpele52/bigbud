import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

import {
  sshHostKeyFingerprint,
  scanPeerHostKeys,
  type PeerHostKeyInspectionOwner,
} from "./peerCoordinator.transport.ts";
import { PeerEnrollmentOwnerUnavailableError } from "./peerSshKey.ts";

const PUBLIC_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PINNED = `ssh-ed25519 ${PUBLIC_KEY}`;
const FINGERPRINT = sshHostKeyFingerprint(PINNED);

type Grant = { host: string; port: number; expiresAt: number; used: boolean };
type KeyMetadata = { keyType: string; fingerprint: string; publicKey: string };

/** Models the owner's one-shot, exact-target, expiring enrollment grant. */
function oneShotOwner(initial: Grant) {
  const grant = { ...initial };
  const calls: Array<{ host: string; port: number }> = [];
  const inspectTrust = vi.fn(async () => {
    throw new Error("ordinary trust must not be consulted");
  });
  return {
    grant,
    calls,
    inspectTrust,
    async inspectPeerHostKey(host: string, port: number): Promise<KeyMetadata> {
      calls.push({ host, port });
      if (host !== grant.host || port !== grant.port) throw new Error("wrong host or port");
      if (grant.used) throw new Error("grant already used");
      if (Date.now() >= grant.expiresAt) throw new Error("grant expired");
      grant.used = true;
      return { keyType: "ssh-ed25519", fingerprint: FINGERPRINT, publicKey: PINNED };
    },
  } satisfies PeerHostKeyInspectionOwner & {
    grant: Grant;
    calls: Array<{ host: string; port: number }>;
    inspectTrust: () => Promise<never>;
  };
}

it("returns only the presented pin metadata for the exact host and port", async () => {
  const owner = oneShotOwner({
    host: "w1.example.test",
    port: 22,
    expiresAt: Date.now() + 5_000,
    used: false,
  });
  await expect(scanPeerHostKeys(owner, "w1.example.test", 22)).resolves.toEqual([
    { pinnedHostKey: PINNED, fingerprint: FINGERPRINT },
  ]);
  expect(owner.calls).toEqual([{ host: "w1.example.test", port: 22 }]);
  expect(owner.inspectTrust).not.toHaveBeenCalled();
});

it("refuses reuse, expiry and a wrong host or port", async () => {
  const base = { host: "w1.example.test", port: 22, used: false };
  await expect(
    (async () => {
      const owner = oneShotOwner({ ...base, expiresAt: Date.now() + 5_000 });
      await scanPeerHostKeys(owner, "w1.example.test", 22);
      await scanPeerHostKeys(owner, "w1.example.test", 22);
    })(),
  ).rejects.toThrow(/already used/);

  await expect(
    scanPeerHostKeys(
      oneShotOwner({ ...base, expiresAt: Date.now() + 5_000 }),
      "w1.example.test",
      2222,
    ),
  ).rejects.toThrow(/wrong host or port/);

  await expect(
    scanPeerHostKeys(oneShotOwner({ ...base, expiresAt: Date.now() - 1 }), "w1.example.test", 22),
  ).rejects.toThrow(/expired/);
});

it("refuses when the owner is not selected and never consults ordinary trust", async () => {
  const trustOnly = { inspectTrust: vi.fn() };
  await expect(scanPeerHostKeys(undefined, "w1.example.test", 22)).rejects.toBeInstanceOf(
    PeerEnrollmentOwnerUnavailableError,
  );
  await expect(
    scanPeerHostKeys(trustOnly as unknown as PeerHostKeyInspectionOwner, "w1.example.test", 22),
  ).rejects.toBeInstanceOf(TypeError);
  expect(trustOnly.inspectTrust).not.toHaveBeenCalled();
});

it("refuses inconsistent owner metadata instead of pinning it", async () => {
  const owner = {
    inspectPeerHostKey: async () => ({
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:not-the-key",
      publicKey: PINNED,
    }),
  };
  await expect(scanPeerHostKeys(owner, "w1.example.test", 22)).rejects.toThrow(/inconsistent/);
});

it("writes no pin and launches no ssh-keyscan", () => {
  const source = readFileSync(new URL("./peerCoordinator.transport.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/node:child_process|execFile\(|spawn\(/);
  expect(source).not.toMatch(/writeFile\(|"known_hosts"|'known_hosts'/);
});

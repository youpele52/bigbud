/**
 * U24 production peer enrollment (W2 T-peer, U9) through the owner-held pin store.
 *
 * The unit cases use a fake owner client. The live case (opt-in) runs the real
 * production owner (`target/debug/bigbud-ssh-owner`) against a disposable worker
 * sshd:
 *   BIGBUD_TEST_PEER_PRODUCTION='{"host":…,"port":…,"user":…}'
 */
import { randomUUID } from "node:crypto";

import { expect, it, vi } from "vitest";

import { withProductionV2Owner } from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import type { PickerProofPeerProductionClient } from "../ssh/sshOwnerPickerProof.client.peerProduction.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.codec.wire.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { makeProductionPeerOwnerAdapters } from "./peerCoordinator.owner.production.ts";
import { sshHostKeyFingerprint } from "./peerCoordinator.transport.ts";
import {
  ensureCoordinatorPeerKey,
  parsePeerPublicKey,
  PeerEnrollmentOwnerUnavailableError,
} from "./peerSshKey.ts";

const KEY = `ssh-ed25519 ${"A".repeat(16)}C3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
const PINNED = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PAIRING = "5eb1c0de-1111-4222-8333-444455556666";
const live = process.env.BIGBUD_TEST_PEER_PRODUCTION;
const COORDINATOR = parsePeerPublicKey(PINNED).fingerprint;

function fakeClient() {
  const challenge = new Uint8Array(32).fill(7);
  return {
    ensureCoordinatorKey: vi.fn(async () => ({
      publicKey: PINNED,
      fingerprint: COORDINATOR,
      algorithm: "ssh-ed25519" as const,
    })),
    inspectHostKey: vi.fn(async () => ({
      keyType: "ssh-ed25519" as const,
      fingerprint: sshHostKeyFingerprint(PINNED),
      publicKey: PINNED,
      challenge,
    })),
    approvePin: vi.fn(async (_challenge: Uint8Array, pairingId: string, user: string) => ({
      pairingId,
      host: "w1.example.test",
      port: 22,
      user,
      hostKeyFingerprint: sshHostKeyFingerprint(PINNED),
      coordinatorKeyFingerprint: COORDINATOR,
    })),
    revokePin: vi.fn(async () => {
      throw new PickerProofOwnerError("peerPinUnknown");
    }),
    openRelay: vi.fn(async () => {
      throw new PickerProofOwnerError("peerPinMismatch");
    }),
    relayStatus: vi.fn(),
    closeRelay: vi.fn(),
  } satisfies PickerProofPeerProductionClient;
}

const registration = (peer: PickerProofPeerProductionClient | undefined) =>
  ({
    handle: { peer },
    descriptorFor: async () => undefined,
  }) as unknown as SshOwnerProductionRegistration;

it("refuses every port without a live production owner", async () => {
  const adapters = makeProductionPeerOwnerAdapters({
    owner: () => undefined,
    getPairing: async () => undefined,
  });
  await expect(ensureCoordinatorPeerKey(adapters.keyOwner)).rejects.toBeInstanceOf(
    PeerEnrollmentOwnerUnavailableError,
  );
  await expect(adapters.hostKeyOwner.inspectPeerHostKey("w1", 22)).rejects.toBeInstanceOf(
    PeerEnrollmentOwnerUnavailableError,
  );
});

it("approves only the scanned challenge for exactly the confirmed key, once", async () => {
  const client = fakeClient();
  const adapters = makeProductionPeerOwnerAdapters({
    owner: () => registration(client),
    getPairing: async () => undefined,
  });
  const key = await ensureCoordinatorPeerKey(adapters.keyOwner);
  expect(key.fingerprint).toBe(COORDINATOR);
  const pin = { pairingId: PAIRING, host: "w1.example.test", port: 22, user: "bbpeer" };
  // No scan, or a different confirmed key, never reaches the owner.
  await expect(adapters.approvePin({ ...pin, pinnedHostKey: PINNED })).rejects.toThrow(/Re-scan/);
  await adapters.hostKeyOwner.inspectPeerHostKey("w1.example.test", 22);
  await expect(adapters.approvePin({ ...pin, pinnedHostKey: KEY })).rejects.toThrow(/Re-scan/);
  expect(client.approvePin).not.toHaveBeenCalled();
  await adapters.hostKeyOwner.inspectPeerHostKey("w1.example.test", 22);
  await adapters.approvePin({ ...pin, pinnedHostKey: PINNED });
  expect(client.approvePin).toHaveBeenCalledWith(new Uint8Array(32).fill(7), PAIRING, "bbpeer");
  // The challenge is spent.
  await expect(adapters.approvePin({ ...pin, pinnedHostKey: PINNED })).rejects.toThrow(/Re-scan/);
  // Revoking an unknown pin is not an error.
  await expect(adapters.revokePin(PAIRING)).resolves.toBeUndefined();
});

it("turns an owner pin mismatch into the host-identity setup outcome", async () => {
  const client = fakeClient();
  const adapters = makeProductionPeerOwnerAdapters({
    owner: () => registration(client),
    getPairing: async () => undefined,
  });
  const lease = await adapters.relayOwner.openPeerRelay(
    { pairing: { pairingId: PAIRING } as never, recipe: "paired-peer-forced-command" },
    new AbortController().signal,
  );
  await expect(lease.exit).resolves.toEqual({
    kind: "setup-refused",
    reason: "host-identity-mismatch",
  });
});

it.skipIf(live === undefined)(
  "live: the production owner provisions, inspects, approves once and revokes",
  async () => {
    const worker = JSON.parse(live!) as { host: string; port: number; user: string };
    await withProductionV2Owner(
      {
        ...worker,
        identityFile: "/unused",
        knownHostsFile: "/unused",
        cwd: "/tmp",
        remoteBinary: "/unused",
      },
      1,
      async ({ handle }) => {
        const peer = handle.peer;
        const first = await peer.ensureCoordinatorKey();
        expect(await peer.ensureCoordinatorKey()).toEqual(first);
        expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
        const presented = await peer.inspectHostKey(worker.host, worker.port);
        expect(presented.fingerprint).toBe(sshHostKeyFingerprint(presented.publicKey));
        const pairingId = randomUUID();
        const pin = await peer.approvePin(presented.challenge, pairingId, worker.user);
        expect(pin).toMatchObject({
          pairingId,
          host: worker.host,
          port: worker.port,
          user: worker.user,
          hostKeyFingerprint: presented.fingerprint,
          coordinatorKeyFingerprint: first.fingerprint,
        });
        await expect(
          peer.approvePin(presented.challenge, pairingId, worker.user),
        ).rejects.toMatchObject({ code: "peerPinUnknown" });
        await expect(peer.revokePin(pairingId)).resolves.toMatchObject({ pairingId });
        await expect(peer.revokePin(pairingId)).rejects.toMatchObject({ code: "peerPinUnknown" });
        await expect(peer.openRelay(new Uint8Array(32).fill(1), pairingId)).rejects.toMatchObject({
          code: "peerPinUnknown",
        });
      },
    );
  },
  120_000,
);

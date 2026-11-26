/**
 * U10 / U24 rootful Linux worker fixture for the production paired relay.
 *
 * The coordinator is the real production owner (`target/debug/bigbud-ssh-owner`)
 * on this host. The worker is a disposable, rootful Linux VM: a root sshd with
 * its own config and host key, a worker account, and a root-owned Node and
 * relay helper behind a `restrict,command=…` line. The owner's root-UID image
 * guard is unchanged; nothing here runs in an unprivileged namespace.
 *
 *   BIGBUD_TEST_PEER_RELAY_LINUX_PRODUCTION='{"host":…,"port":…,"user":…,
 *     "nodeBinary":…,"helperEntry":…,"authorize":"/abs/script"}'
 *
 * `authorize` is an operator script that installs the authorized_keys line it
 * reads on stdin for the worker account (for example through the VM console).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buffer } from "node:stream/consumers";

import type { PeerPairing } from "@bigbud/contracts/server/remotePeer.pairing.ts";
import { expect, it } from "vitest";

import { withProductionV2Owner } from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import { peerAuthorizedKeysLine } from "../remote-backend/peerAuthorizedKeys.ts";
import { makeOwnedPeerRelaySshChannels } from "../remote-backend/peerRelay.ssh.owner.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { makeProductionPeerOwnerAdapters } from "./peerCoordinator.owner.production.ts";
import { sshHostKeyFingerprint } from "./peerCoordinator.transport.ts";

const live = process.env.BIGBUD_TEST_PEER_RELAY_LINUX_PRODUCTION;
const WORKER = "c".repeat(32);
const COORDINATOR_AUTHORITY = "b".repeat(32);
const AT = "2026-11-26T00:00:00Z";

it.skipIf(live === undefined)(
  "relays bytes to a rootful Linux worker using only the owner's own pin",
  async () => {
    const worker = JSON.parse(live!) as {
      host: string;
      port: number;
      user: string;
      nodeBinary: string;
      helperEntry: string;
      authorize: string;
    };
    await withProductionV2Owner(
      {
        host: worker.host,
        port: worker.port,
        user: worker.user,
        identityFile: "/unused",
        knownHostsFile: "/unused",
        cwd: "/tmp",
        remoteBinary: "/unused",
      },
      1,
      async ({ handle }) => {
        const pairings = new Map<string, PeerPairing>();
        const registration = {
          handle,
          descriptorFor: async () => undefined,
        } as unknown as SshOwnerProductionRegistration;
        const adapters = makeProductionPeerOwnerAdapters({
          owner: () => registration,
          getPairing: async (id) => pairings.get(id),
        });
        const key = await adapters.keyOwner.ensurePeerCoordinatorKey();
        const grantId = randomUUID();
        execFileSync(worker.authorize, [], {
          input: `${peerAuthorizedKeysLine({
            nodeBinary: worker.nodeBinary,
            helperEntry: worker.helperEntry,
            workerAuthorityId: WORKER,
            grantId,
            coordinatorAuthorityId: COORDINATOR_AUTHORITY,
            publicKey: key.publicKey,
          })}\n`,
        });
        const [presented] = [
          await adapters.hostKeyOwner.inspectPeerHostKey(worker.host, worker.port),
        ];
        const pairingId = randomUUID();
        const pairing: PeerPairing = {
          pairingId,
          label: "Rootful Linux worker",
          workerAuthorityId: WORKER,
          host: worker.host,
          port: worker.port,
          user: worker.user,
          pinnedHostKey: presented!.publicKey,
          hostKeyFingerprint: sshHostKeyFingerprint(presented!.publicKey),
          hostKeyConfirmedAt: AT,
          workspaceRoot: "/tmp/peer-workspace",
          provider: "codex",
          runtimeMode: "full-access",
          coordinatorKeyFingerprint: key.fingerprint,
          grantId,
          grantRecordedAt: AT,
          grantRevokedAt: null,
          createdAt: AT,
          updatedAt: AT,
        };
        await adapters.approvePin({ ...pairing, pinnedHostKey: pairing.pinnedHostKey });
        pairings.set(pairingId, pairing);

        const relay = makeOwnedPeerRelaySshChannels(pairing, adapters.relayOwner);
        try {
          const channel = await relay.openChannel(new AbortController().signal);
          const data = Buffer.from(Array.from({ length: 130 * 1024 }, (_, i) => i % 251));
          const read = buffer(channel.stream);
          channel.stream.end(data);
          const received = await read;
          const newline = received.indexOf(10);
          // The worker's forced command saw exactly this grant and coordinator key.
          expect(JSON.parse(received.subarray(0, newline).toString("utf8"))).toEqual([
            WORKER,
            grantId,
            COORDINATOR_AUTHORITY,
            key.fingerprint,
          ]);
          expect(received.subarray(newline + 1).equals(data)).toBe(true);
          await expect(channel.outcome).resolves.toBe("closed");
        } finally {
          await relay.dispose();
        }

        // After the owner pin is revoked, the same saved pairing cannot dial.
        await adapters.revokePin(pairingId);
        const revoked = makeOwnedPeerRelaySshChannels(pairing, adapters.relayOwner);
        try {
          await expect(revoked.openChannel(new AbortController().signal)).rejects.toMatchObject({
            code: "authorization-refused",
          });
        } finally {
          await revoked.dispose();
        }
        // A confirmed key other than the scanned one is never approved.
        await adapters.hostKeyOwner.inspectPeerHostKey(worker.host, worker.port);
        await expect(
          adapters.approvePin({
            ...pairing,
            pinnedHostKey:
              "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
          }),
        ).rejects.toThrow(/Re-scan/);
      },
    );
  },
  180_000,
);

import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import type { PeerPairing } from "@bigbud/contracts/server/remotePeer.pairing.ts";
import { expect, it, vi } from "vitest";

import { ClientRelayStdioSocket } from "../remote-backend/clientRelay.stdio.ts";
import {
  makeOwnedPeerRelaySshChannels,
  PeerRelayAdmissionError,
  type PeerRelayOwnerExit,
  type PeerRelaySshOwner,
} from "../remote-backend/peerRelay.ssh.owner.ts";
import { makeSshPeerTransport } from "./peerCoordinator.transport.ts";

const legacy = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: legacy.spawn, execFile: legacy.execFile }));

const PUBLIC_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const now = "2026-11-25T00:00:00.000Z";
const pairing = {
  pairingId: "00000000-0000-4000-8000-000000000001",
  label: "Worker",
  workerAuthorityId: "a".repeat(32),
  host: "worker.example",
  port: 2222,
  user: "peer",
  pinnedHostKey: `ssh-ed25519 ${PUBLIC_KEY}`,
  hostKeyFingerprint: "SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk",
  hostKeyConfirmedAt: now,
  workspaceRoot: "/srv/workspace",
  provider: "codex",
  runtimeMode: "full-access",
  coordinatorKeyFingerprint: `sha256:${"b".repeat(64)}`,
  grantId: "00000000-0000-4000-8000-000000000002",
  grantRecordedAt: now,
  grantRevokedAt: null,
  createdAt: now,
  updatedAt: now,
} satisfies PeerPairing;

const signal = () => new AbortController().signal;

function lease() {
  const stdin = new PassThrough({ highWaterMark: 1024 });
  const stdout = new PassThrough({ highWaterMark: 1024 });
  const exited = Promise.withResolvers<PeerRelayOwnerExit>();
  const cancel = vi.fn(async () => {});
  return {
    stdin,
    stdout,
    exited,
    lease: { stream: new ClientRelayStdioSocket(stdout, stdin), exit: exited.promise, cancel },
  };
}

function mockOwner() {
  return {
    resolvePeerRelayApproval: vi
      .fn<PeerRelaySshOwner["resolvePeerRelayApproval"]>()
      .mockResolvedValue({ pairing, coordinatorKeyFingerprint: pairing.coordinatorKeyFingerprint }),
    openPeerRelay: vi.fn<PeerRelaySshOwner["openPeerRelay"]>(),
  };
}

function ownerWithApproval(resolve: PeerRelaySshOwner["resolvePeerRelayApproval"]) {
  const openPeerRelay = vi.fn<PeerRelaySshOwner["openPeerRelay"]>();
  const owner: PeerRelaySshOwner = { resolvePeerRelayApproval: resolve, openPeerRelay };
  return { owner, openPeerRelay };
}

it("requires the saved pairing pin and the coordinator identity bound by the grant", async () => {
  const missing = ownerWithApproval(async () => undefined);
  await expect(
    makeOwnedPeerRelaySshChannels(pairing, missing.owner).openChannel(signal()),
  ).rejects.toMatchObject({ code: "authorization-refused" });
  expect(missing.openPeerRelay).not.toHaveBeenCalled();

  const changedIdentity = ownerWithApproval(async () => ({
    pairing,
    coordinatorKeyFingerprint: `sha256:${"c".repeat(64)}`,
  }));
  await expect(
    makeOwnedPeerRelaySshChannels(pairing, changedIdentity.owner).openChannel(signal()),
  ).rejects.toMatchObject({ code: "authentication-refused" });

  for (const forged of [
    { ...pairing, hostKeyConfirmedAt: "" },
    { ...pairing, pinnedHostKey: "ssh-ed25519 AAAA" },
  ]) {
    const ordinary = ownerWithApproval(async () => ({
      pairing: forged,
      coordinatorKeyFingerprint: pairing.coordinatorKeyFingerprint,
    }));
    await expect(
      makeOwnedPeerRelaySshChannels(pairing, ordinary.owner).openChannel(signal()),
    ).rejects.toBeInstanceOf(PeerRelayAdmissionError);
  }
});

it("keeps the framed duplex half-close and bounded bytes", async () => {
  const transport = lease();
  const port = mockOwner();
  port.openPeerRelay.mockResolvedValue(transport.lease);
  const channels = makeOwnedPeerRelaySshChannels(pairing, port);
  const channel = await channels.openChannel(signal());

  const bytes = Buffer.alloc(130 * 1024, 0xff);
  const received = (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of transport.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  })();
  expect(channel.stream.write(bytes)).toBe(false);
  channel.stream.end();
  expect(await received).toEqual(bytes);

  const tail = Buffer.from([0, 255, 0]);
  transport.stdout.write(tail);
  transport.exited.resolve({ kind: "exited", code: 0 });
  await expect(channel.outcome).resolves.toBe("closed");
  transport.stdout.end();
  const chunks: Buffer[] = [];
  for await (const chunk of channel.stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(tail);
  await channels.dispose();
  expect(transport.lease.cancel).not.toHaveBeenCalled();
});

it("has no ssh binary override and refuses without a selected owner", async () => {
  const transport = makeSshPeerTransport({});
  await expect(
    transport.request({
      pairing,
      action: "status",
      body: {},
      deadlineMs: 1_000,
      signal: signal(),
    }),
  ).resolves.toEqual({
    _tag: "unreachable",
    message: "The selected SSH owner is unavailable for peer relay.",
  });
  expect(legacy.spawn).not.toHaveBeenCalled();
  expect(legacy.execFile).not.toHaveBeenCalled();

  const transportSource = readFileSync(
    new URL("./peerCoordinator.transport.ts", import.meta.url),
    "utf8",
  );
  expect(transportSource).not.toMatch(/sshBinary|identityFile|keyFile|makePeerRelaySshChannels/);
  const ownerSource = readFileSync(
    new URL("../remote-backend/peerRelay.ssh.owner.ts", import.meta.url),
    "utf8",
  );
  expect(ownerSource).not.toMatch(/node:child_process|sshBinary|identityFile/);
});

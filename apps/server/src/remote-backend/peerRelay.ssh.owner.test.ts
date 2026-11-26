import { once } from "node:events";
import { PassThrough } from "node:stream";
import type { PeerPairing } from "@bigbud/contracts/server/remotePeer.pairing.ts";
import { afterEach, expect, it, vi } from "vitest";

import { ClientRelayStdioSocket } from "./clientRelay.stdio.ts";
import {
  makeOwnedPeerRelaySshChannels,
  type PeerRelayOwnerExit,
  type PeerRelaySshOwner,
} from "./peerRelay.ssh.owner.ts";

const legacy = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  ready: vi.fn(),
  trust: vi.fn(),
  build: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: legacy.spawn, execFile: legacy.execFile }));

const now = "2026-11-23T00:00:00.000Z";
const pairing = {
  pairingId: "00000000-0000-4000-8000-000000000001",
  label: "Worker",
  workerAuthorityId: "a".repeat(32),
  host: "worker.example",
  port: 2222,
  user: "peer",
  pinnedHostKey: "ssh-ed25519 AAAA",
  hostKeyFingerprint: "SHA256:fixture",
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
const approval = { pairing, coordinatorKeyFingerprint: pairing.coordinatorKeyFingerprint };
const signal = () => new AbortController().signal;
const success = { kind: "exited", code: 0 } as const;
const terminated = { kind: "signaled", signal: "SIGTERM" } as const;

function pipes() {
  const stdin = new PassThrough({ highWaterMark: 1024 });
  const stdout = new PassThrough({ highWaterMark: 1024 });
  const stream = new ClientRelayStdioSocket(stdout, stdin);
  const exited = Promise.withResolvers<PeerRelayOwnerExit>();
  const cancel = vi.fn(async () => {});
  return { stdin, stdout, exited, cancel, lease: { stream, exit: exited.promise, cancel } };
}

function ownerPort() {
  return {
    resolvePeerRelayApproval: vi
      .fn<PeerRelaySshOwner["resolvePeerRelayApproval"]>()
      .mockResolvedValue(approval),
    openPeerRelay: vi.fn<PeerRelaySshOwner["openPeerRelay"]>(),
  } satisfies PeerRelaySshOwner;
}

async function collect(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

afterEach(() => {
  vi.useRealTimers();
  for (const fn of Object.values(legacy)) {
    expect(fn).not.toHaveBeenCalled();
    fn.mockClear();
  }
});

it("projects only the exact pairing and fixed peer recipe, and drains binary stdout after stdin EOF and reap", async () => {
  const transport = pipes();
  const port = ownerPort();
  port.openPeerRelay.mockResolvedValue(transport.lease);
  const callerPairing = {
    ...pairing,
    args: ["no"],
    env: { SSH_AUTH_SOCK: "no" },
    identityFile: "/no",
  };
  const channels = makeOwnedPeerRelaySshChannels(callerPairing, port);
  callerPairing.port = 9999;
  expect(port.resolvePeerRelayApproval).not.toHaveBeenCalled();
  const channel = await channels.openChannel(signal());
  expect(port.resolvePeerRelayApproval).toHaveBeenCalledExactlyOnceWith(
    pairing.pairingId,
    expect.any(AbortSignal),
  );
  expect(port.openPeerRelay).toHaveBeenCalledExactlyOnceWith(
    { pairing, recipe: "paired-peer-forced-command" },
    expect.any(AbortSignal),
  );

  const bytes = Buffer.alloc(128 * 1024, 0xff);
  const received = collect(transport.stdin);
  expect(channel.stream.write(bytes)).toBe(false);
  channel.stream.end();
  expect(await received).toEqual(bytes);
  const tail = Buffer.from([0, 255, 0]);
  transport.stdout.write(tail);
  transport.exited.resolve(success);
  await expect(channel.outcome).resolves.toBe("closed");
  expect(channel.stream.destroyed).toBe(false);
  transport.stdout.end();
  expect(await collect(channel.stream)).toEqual(tail);
  await channels.dispose();
  expect(transport.cancel).not.toHaveBeenCalled();
});

it.each([
  ["unknown pairing", undefined],
  ["different pairing ID", { ...approval, pairing: { ...pairing, pairingId: pairing.grantId } }],
  ["different SSH user", { ...approval, pairing: { ...pairing, user: "other" } }],
  ["different SSH port", { ...approval, pairing: { ...pairing, port: 22 } }],
  ["different SSH host", { ...approval, pairing: { ...pairing, host: "other.example" } }],
  [
    "different worker authority",
    { ...approval, pairing: { ...pairing, workerAuthorityId: "c".repeat(32) } },
  ],
  [
    "rotated host pin",
    { ...approval, pairing: { ...pairing, pinnedHostKey: "ssh-ed25519 AAAAB3Nz" } },
  ],
  ["unconfirmed pin", { ...approval, pairing: { ...pairing, hostKeyConfirmedAt: "" } }],
  ["revoked grant", { ...approval, pairing: { ...pairing, grantRevokedAt: now } }],
  ["missing grant", { ...approval, pairing: { ...pairing, grantId: null } }],
  ["replaced grant", { ...approval, pairing: { ...pairing, grantId: pairing.pairingId } }],
  [
    "revised pairing",
    { ...approval, pairing: { ...pairing, updatedAt: "2026-11-23T00:00:01.000Z" } },
  ],
] as const)("refuses %s before transport dispatch", async (_name, current) => {
  const port = ownerPort();
  port.resolvePeerRelayApproval.mockResolvedValue(current);
  const channels = makeOwnedPeerRelaySshChannels(pairing, port);
  await expect(channels.openChannel(signal())).rejects.toMatchObject({
    code: "authorization-refused",
  });
  expect(port.openPeerRelay).not.toHaveBeenCalled();
  await channels.dispose();
});

it("requires an active prior approval and rejects a replaced dedicated coordinator identity", async () => {
  const port = ownerPort();
  expect(() => makeOwnedPeerRelaySshChannels({ ...pairing, grantRevokedAt: now }, port)).toThrow(
    "revoked",
  );
  expect(() => makeOwnedPeerRelaySshChannels({ ...pairing, hostKeyConfirmedAt: "" }, port)).toThrow(
    "changed",
  );
  expect(port.resolvePeerRelayApproval).not.toHaveBeenCalled();
  port.resolvePeerRelayApproval.mockResolvedValue({
    ...approval,
    coordinatorKeyFingerprint: `sha256:${"c".repeat(64)}`,
  });
  const channels = makeOwnedPeerRelaySshChannels(pairing, port);
  await expect(channels.openChannel(signal())).rejects.toMatchObject({
    code: "authentication-refused",
  });
  expect(port.openPeerRelay).not.toHaveBeenCalled();
  await channels.dispose();
});

it("rechecks approval on each open without closing an existing lease on refusal", async () => {
  const transport = pipes();
  const port = ownerPort();
  port.openPeerRelay.mockResolvedValue(transport.lease);
  const channels = makeOwnedPeerRelaySshChannels(pairing, port);
  const channel = await channels.openChannel(signal());
  port.resolvePeerRelayApproval.mockResolvedValue({
    ...approval,
    pairing: { ...pairing, grantRevokedAt: now },
  });
  await expect(channels.openChannel(signal())).rejects.toMatchObject({
    code: "authorization-refused",
  });
  expect(port.resolvePeerRelayApproval).toHaveBeenCalledTimes(2);
  expect(port.openPeerRelay).toHaveBeenCalledTimes(1);
  expect(channel.stream.destroyed).toBe(false);
  expect(transport.cancel).not.toHaveBeenCalled();
  transport.exited.resolve(success);
  await channels.dispose();
});

it("does not dispatch following cancellation during preflight or retry an owner refusal at dispatch", async () => {
  const port = ownerPort();
  const channels = makeOwnedPeerRelaySshChannels(pairing, port);
  await expect(channels.openChannel(AbortSignal.abort())).rejects.toThrow();
  expect(port.resolvePeerRelayApproval).not.toHaveBeenCalled();
  const controller = new AbortController();
  port.resolvePeerRelayApproval.mockImplementationOnce(async () => {
    controller.abort(new Error("cancelled while resolving pairing"));
    return approval;
  });
  await expect(channels.openChannel(controller.signal)).rejects.toThrow(
    "cancelled while resolving pairing",
  );
  expect(port.openPeerRelay).not.toHaveBeenCalled();
  port.openPeerRelay.mockRejectedValue(new Error("approval changed before dispatch"));
  await expect(channels.openChannel(signal())).rejects.toThrow("approval changed before dispatch");
  await channels.dispose();
  await expect(channels.openChannel(signal())).rejects.toThrow("disposed");
  expect(port.openPeerRelay).toHaveBeenCalledTimes(1);
});

it.each([
  [{ kind: "setup-refused", reason: "host-identity-mismatch" }, "host-identity-mismatch"],
  [{ kind: "setup-refused", reason: "authentication-refused" }, "authentication-refused"],
  [{ kind: "exited", code: 1 }, "unreachable"],
  [terminated, "unreachable"],
] as const)("classifies a confirmed %j exit as %s", async (exit, expected) => {
  const transport = pipes();
  const port = ownerPort();
  port.openPeerRelay.mockResolvedValue(transport.lease);
  const channels = makeOwnedPeerRelaySshChannels(pairing, port);
  const channel = await channels.openChannel(signal());
  transport.exited.resolve(exit);
  await expect(channel.outcome).resolves.toBe(expected);
  await channels.dispose();
  expect(transport.cancel).not.toHaveBeenCalled();
});

it("disposal aborts acquisition, cancels a late lease, and waits for its confirmed reap", async () => {
  const transport = pipes();
  const port = ownerPort();
  const started = Promise.withResolvers<AbortSignal>();
  const acquired = Promise.withResolvers<typeof transport.lease>();
  port.openPeerRelay.mockImplementation((_request, ownedSignal) => {
    started.resolve(ownedSignal);
    return acquired.promise;
  });
  const channels = makeOwnedPeerRelaySshChannels(pairing, port);
  const rejected = expect(channels.openChannel(signal())).rejects.toThrow("disposed");
  const ownedSignal = await started.promise;
  const disposed = channels.dispose();
  expect(channels.dispose()).toBe(disposed);
  expect(ownedSignal.aborted).toBe(true);
  const done = vi.fn();
  void disposed.then(done);
  const closed = once(transport.lease.stream, "close");
  acquired.resolve(transport.lease);
  await closed;
  expect(transport.cancel).toHaveBeenCalledTimes(1);
  expect(done).not.toHaveBeenCalled();
  transport.exited.resolve(terminated);
  await rejected;
  await disposed;
  expect(done).toHaveBeenCalledTimes(1);
});

it("cancels only the abandoned peer channel and fails cleanup if its exit is not confirmed", async () => {
  vi.useFakeTimers();
  const abandoned = pipes();
  const sibling = pipes();
  const port = ownerPort();
  port.openPeerRelay.mockResolvedValueOnce(abandoned.lease).mockResolvedValueOnce(sibling.lease);
  const channels = makeOwnedPeerRelaySshChannels(pairing, port);
  const abort = new AbortController();
  const first = await channels.openChannel(abort.signal);
  const second = await channels.openChannel(signal());
  const closed = once(first.stream, "close");
  abort.abort();
  await closed;
  expect(abandoned.cancel).toHaveBeenCalledTimes(1);
  expect(sibling.cancel).not.toHaveBeenCalled();
  expect(second.stream.destroyed).toBe(false);
  sibling.exited.resolve(success);
  await expect(second.outcome).resolves.toBe("closed");
  const failed = expect(channels.dispose()).rejects.toThrow("could not confirm owned child exit");
  await vi.advanceTimersByTimeAsync(2500);
  await failed;
  expect(abandoned.cancel).toHaveBeenCalledTimes(1);
  expect(sibling.cancel).not.toHaveBeenCalled();
  abandoned.exited.resolve(terminated);
});

it("reports lost exit confirmation without exposing owner diagnostics or cancelling siblings", async () => {
  const lost = pipes();
  const sibling = pipes();
  const port = ownerPort();
  port.openPeerRelay.mockResolvedValueOnce(lost.lease).mockResolvedValueOnce(sibling.lease);
  const channels = makeOwnedPeerRelaySshChannels(pairing, port);
  const first = await channels.openChannel(signal());
  const second = await channels.openChannel(signal());
  const error = once(first.stream, "error");
  lost.exited.reject(new Error("private owner diagnostics"));
  await expect(error).resolves.toEqual([new Error("SSH peer relay lost exit confirmation.")]);
  await expect(first.outcome).resolves.toBe("unreachable");
  expect(lost.cancel).toHaveBeenCalledTimes(1);
  expect(sibling.cancel).not.toHaveBeenCalled();
  expect(second.stream.destroyed).toBe(false);
  sibling.exited.resolve(success);
  await expect(channels.dispose()).rejects.toThrow("lost exit confirmation");
});

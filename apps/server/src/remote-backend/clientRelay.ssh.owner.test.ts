import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

import { openRemoteBackendRelayProfileOwner } from "./clientRelay.profileOwner.ts";
import type { ResolvedRemoteBackendRelayProfile } from "./clientRelay.profiles.ts";
import type { ClientRelayOwnerExit, ClientRelayOwnerRequest } from "./clientRelay.ssh.owner.ts";
import { makeClientRelaySshChannels } from "./clientRelay.ssh.ts";
import { ClientRelayStdioSocket } from "./clientRelay.stdio.ts";
import { backend, remote } from "./clientRelay.test.helpers.ts";

const legacy = vi.hoisted(() => ({
  ready: vi.fn(),
  trust: vi.fn(),
  build: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: legacy.spawn }));

afterEach(() => {
  vi.useRealTimers();
  for (const call of Object.values(legacy)) {
    expect(call).not.toHaveBeenCalled();
    call.mockClear();
  }
});

const target = {
  executionTargetId: "ssh:host=relay-fixture&user=viewer&port=2022",
  deployment: {
    nodeBinary: "/private/node",
    nodeSha256: "a".repeat(64),
    helperEntry: "/private/relay helper.mjs",
    helperSha256: "b".repeat(64),
    authorityId: "c".repeat(32),
  },
} satisfies ClientRelayOwnerRequest;
const signal = () => new AbortController().signal;
const success = { kind: "exited", code: 0 } as const;

function ownedPipes() {
  const stdin = new PassThrough({ highWaterMark: 1024 });
  const stdout = new PassThrough({ highWaterMark: 1024 });
  const stream = new ClientRelayStdioSocket(stdout, stdin);
  const exited = Promise.withResolvers<ClientRelayOwnerExit>();
  const cancel = vi.fn(async () => {});
  const lease = { stream, exit: exited.promise, cancel };
  return { stdin, stdout, exited, cancel, lease };
}

it("opens the typed port through the approved profile's real HTTP channel, never at lease creation", async () => {
  const approved: ResolvedRemoteBackendRelayProfile = {
    ...target,
    profile: {
      profileId: "fixture",
      label: "Fixture",
      identity: {
        authority: {
          authorityId: target.deployment.authorityId,
          keyFingerprint: `sha256:${"d".repeat(64)}`,
          keyEpoch: 1,
        },
        installationFingerprint: `sha256:${"e".repeat(64)}`,
      },
    },
  };
  const upstream = await backend((request, response) =>
    response.end(
      request.headers.authorization === "Bearer private-receiver" ? "relayed" : "denied",
    ),
  );
  const helper = remote(upstream.socketPath, "private-receiver");
  const exit = Promise.withResolvers<ClientRelayOwnerExit>();
  const openClientRelay = vi.fn(async () => ({
    stream: helper.stream,
    exit: exit.promise,
    cancel() {
      helper.close();
      exit.resolve(success);
    },
  }));
  const resolved = { ...approved, sshOwner: { openClientRelay } };
  try {
    await expect(
      openRemoteBackendRelayProfileOwner(
        { ...resolved, deployment: { ...target.deployment, authorityId: "0".repeat(32) } },
        [],
        signal(),
      ),
    ).rejects.toThrow("inconsistent ownership");
    const endpoint = await openRemoteBackendRelayProfileOwner(resolved, [], signal());
    try {
      expect(openClientRelay).not.toHaveBeenCalled();
      const response = await fetch(endpoint.baseUrl + "/asset", {
        headers: {
          authorization: `Bearer ${endpoint.localCredential}`,
          "x-bigbud-client-rpc-revision": "1",
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("relayed");
      expect(openClientRelay).toHaveBeenCalledExactlyOnceWith(target, expect.any(AbortSignal));
    } finally {
      await endpoint.dispose();
    }
  } finally {
    helper.close();
    await upstream.close();
  }
});

it("projects only the pinned deployment and preserves binary stdout after stdin EOF and confirmed exit", async () => {
  const pipes = ownedPipes();
  const openClientRelay = vi.fn(async () => pipes.lease);
  const unprojected = {
    ...target,
    deployment: { ...target.deployment, env: { NOT_FORWARDED: "fixture" } },
    args: ["not forwarded"],
    sshOwner: { openClientRelay },
  };
  const owner = makeClientRelaySshChannels(unprojected);
  const stream = await owner.openChannel(signal());
  expect(openClientRelay).toHaveBeenCalledExactlyOnceWith(target, expect.any(AbortSignal));

  const bytes = Buffer.alloc(128 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const received = collect(pipes.stdin);
  expect(stream.write(bytes)).toBe(false); // Exceeds the channel's writable high-water mark.
  stream.end();
  expect(await received).toEqual(bytes);
  const suffix = Buffer.from([255, 0, 254]);
  pipes.stdout.write(suffix);
  pipes.exited.resolve({ kind: "exited", code: 1 });
  await pipes.exited.promise;
  expect(stream.destroyed).toBe(false);
  pipes.stdout.end();
  expect(await collect(stream)).toEqual(suffix);
  await owner.dispose();
  expect(pipes.cancel).not.toHaveBeenCalled();
});

it("rejects invalid target or deployment before opening either path", () => {
  const openClientRelay = vi.fn();
  const input = { ...target, sshOwner: { openClientRelay } };
  expect(() => makeClientRelaySshChannels({ ...input, executionTargetId: "local" })).toThrow(
    "target",
  );
  expect(() =>
    makeClientRelaySshChannels({
      ...input,
      deployment: { ...target.deployment, nodeSha256: "bad" },
    }),
  ).toThrow("deployment");
  expect(openClientRelay).not.toHaveBeenCalled();
});

it("does not fall back when the typed owner rejects or the caller is already cancelled", async () => {
  const openClientRelay = vi.fn(async () => {
    throw new Error("owner refused trust");
  });
  const owner = makeClientRelaySshChannels({ ...target, sshOwner: { openClientRelay } });
  await expect(owner.openChannel(AbortSignal.abort())).rejects.toThrow();
  expect(openClientRelay).not.toHaveBeenCalled();
  await expect(owner.openChannel(signal())).rejects.toThrow("owner refused trust");
  await owner.dispose();
  await expect(owner.openChannel(signal())).rejects.toThrow("disposed");
  expect(openClientRelay).toHaveBeenCalledTimes(1);
});

it("aborts a pending acquisition on disposal and reaps a late-returned lease", async () => {
  const pipes = ownedPipes();
  const admitted = Promise.withResolvers<typeof pipes.lease>();
  const started = Promise.withResolvers<AbortSignal>();
  const owner = makeClientRelaySshChannels({
    ...target,
    sshOwner: {
      openClientRelay: (_request, ownedSignal) => {
        started.resolve(ownedSignal);
        return admitted.promise;
      },
    },
  });
  const opening = owner.openChannel(signal());
  const ownedSignal = await started.promise;
  const disposal = owner.dispose();
  expect(ownedSignal.aborted).toBe(true);
  const closed = once(pipes.lease.stream, "close");
  admitted.resolve(pipes.lease);
  await closed;
  expect(pipes.cancel).toHaveBeenCalledTimes(1);
  const settled = vi.fn();
  void disposal.then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  pipes.exited.resolve({ kind: "signaled", signal: "SIGTERM" });
  await expect(opening).rejects.toThrow("disposed");
  await disposal;
  expect(settled).toHaveBeenCalledTimes(1);
});

it("cancels only the abandoned channel and refuses to equate cancel acknowledgement with reap", async () => {
  vi.useFakeTimers();
  const abandoned = ownedPipes();
  const sibling = ownedPipes();
  const openClientRelay = vi
    .fn()
    .mockResolvedValueOnce(abandoned.lease)
    .mockResolvedValueOnce(sibling.lease);
  const owner = makeClientRelaySshChannels({ ...target, sshOwner: { openClientRelay } });
  const controller = new AbortController();
  const first = await owner.openChannel(controller.signal);
  const second = await owner.openChannel(signal());
  const closed = once(first, "close");
  controller.abort();
  await closed;
  expect(abandoned.cancel).toHaveBeenCalledTimes(1);
  expect(sibling.cancel).not.toHaveBeenCalled();
  expect(second.destroyed).toBe(false);
  sibling.exited.resolve(success);
  const cleanup = expect(owner.dispose()).rejects.toThrow("confirm owned child exit");
  await vi.advanceTimersByTimeAsync(2500);
  await cleanup;
  expect(abandoned.cancel).toHaveBeenCalledTimes(1);
  abandoned.exited.resolve({ kind: "signaled", signal: "SIGTERM" });
});

it("reports lost exit confirmation but still waits for other owned channels to reap", async () => {
  const lost = ownedPipes();
  const sibling = ownedPipes();
  const openClientRelay = vi
    .fn()
    .mockResolvedValueOnce(lost.lease)
    .mockResolvedValueOnce(sibling.lease);
  const owner = makeClientRelaySshChannels({ ...target, sshOwner: { openClientRelay } });
  await owner.openChannel(signal());
  const second = await owner.openChannel(signal());
  const siblingClosed = once(second, "close");
  const settled = vi.fn();
  const disposal = owner.dispose();
  void disposal.then(settled, settled);
  await siblingClosed;
  lost.exited.reject(new Error("owner connection lost"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).not.toHaveBeenCalled();
  sibling.exited.resolve(success);
  await expect(disposal).rejects.toThrow("lost exit confirmation");
  expect(lost.cancel).toHaveBeenCalledTimes(1);
});

it("reports a generic channel error on loss of exit confirmation", async () => {
  const pipes = ownedPipes();
  const owner = makeClientRelaySshChannels({
    ...target,
    sshOwner: { openClientRelay: async () => pipes.lease },
  });
  const stream = await owner.openChannel(signal());
  const error = once(stream, "error");
  pipes.exited.reject(new Error("owner connection lost"));
  await expect(error).resolves.toEqual([new Error("SSH backend relay lost exit confirmation.")]);
  await expect(owner.dispose()).rejects.toThrow("lost exit confirmation");
  expect(pipes.cancel).toHaveBeenCalledTimes(1);
});

async function collect(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
